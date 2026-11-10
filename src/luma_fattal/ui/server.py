"""Loopback-only UI server. Media and jobs stay in a private session directory."""

from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from fractions import Fraction
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import NotRequired, TypedDict, cast
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import numpy as np
import yaml
from PIL import Image

from ..cleanup import MultiscaleSourceCleanup, SourceCleanup
from ..configuration import Config, _ConfigLoader
from ..core import ColorInputBudget, ToneMapSlot
from ..denoise import SourceDenoise
from ..gpu import GPUUnavailable
from ..gpu_core import CudaCore
from ..prenoise import SourceNoise
from ..processing import process_pixels
from ..video import (
    _decode_command,
    _geometry,
    _probe,
    _resolve_color,
    _source_rate,
    process_video,
)

STATIC = Path(__file__).parent
REPOSITORY = STATIC.parents[2]
PREVIEW_CACHE_BYTES = 128 * 1024 * 1024
PREVIEW_BITMAP_BYTES = 128 * 1024 * 1024
PREVIEW_COLOR_BYTES = 96 * 1024 * 1024


class _PreviewFrame(TypedDict):
    time: float
    width: int
    height: int
    url: NotRequired[str]


def sample_times(duration: float) -> list[float]:
    """Sample the centers of five equal-duration segments, avoiding the EOF edge."""
    if not np.isfinite(duration) or duration <= 0:
        raise ValueError("Video duration must be finite and positive")
    return [duration * (index + 0.5) / 5 for index in range(5)]


def decoded_sample(
    source: Path,
    config: Config,
    timestamp: float,
    max_edge: int | None = None,
    *,
    stream: dict | None = None,
) -> np.ndarray:
    """Decode one color-normalized sample with an optional output size bound."""
    if stream is None:
        stream = cast(dict, _probe(source, "ffprobe"))
    dimensions, rotation, _ = _geometry(stream)
    color, _ = _resolve_color(stream, config.video)
    command = _decode_command(
        "ffmpeg",
        source,
        stream,
        config.video.deblock,
        config.video.deband,
        color=color,
        dimensions=dimensions,
        rotation=rotation,
        interlaced=stream.get("field_order") not in (None, "unknown", "progressive"),
    )
    # Input seeking avoids decoding the whole clip for every sample.
    command[command.index("-i") : command.index("-i")] = ["-ss", str(timestamp)]
    if max_edge is not None:
        scale = min(1, max_edge / max(dimensions))
        dimensions = tuple(max(2, round(edge * scale)) for edge in dimensions)
        command[command.index("-vf") + 1] += f",scale={dimensions[0]}:{dimensions[1]}"
    command[-1:-1] = ["-frames:v", "1"]
    decoded = subprocess.run(command, capture_output=True, check=True, timeout=120)
    width, height = dimensions
    if not decoded.stdout and timestamp > 0:
        # A short clip's final segment may lie after its last presentation time.
        from fractions import Fraction

        rate = Fraction(stream.get("avg_frame_rate", "0/1"))
        step = float(1 / rate) if rate > 0 else 1.0
        command[command.index("-ss") + 1] = str(max(0, timestamp - step))
        decoded = subprocess.run(command, capture_output=True, check=True, timeout=120)
    if len(decoded.stdout) != width * height * 3:
        raise ValueError("Could not decode a preview frame at this timestamp")
    return np.frombuffer(decoded.stdout, np.uint8).reshape(height, width, 3).copy()


@dataclass
class _PreviewToneMaps:
    cpu: ToneMapSlot[np.ndarray] = field(default_factory=ToneMapSlot[np.ndarray])
    cuda: ToneMapSlot = field(default_factory=ToneMapSlot)


class _PreviewSamples:
    """Retain decoded pixels for the current source and decode settings."""

    @staticmethod
    def key_for(source: Path, config: Config):
        video = config.video
        return source, video.input_color, video.input_range, video.deblock, video.deband

    def __init__(self, source: Path, config: Config):
        self.source = source
        self.key = self.key_for(source, config)
        self.stream = _probe(source, "ffprobe")
        self.frames: dict[float, np.ndarray] = {}
        self.bytes_used = 0
        self.tone_key = None
        self.tone_maps: dict[float, _PreviewToneMaps] = {}

    def tone_maps_for(self, config: Config, timestamps: list[float]):
        params, video = config.parameters, config.video
        # Track inputs that can change the solve. Color controls and Fade are
        # applied afterward, including when the result is enlarged.
        key = (
            tuple(timestamps),
            config.filter,
            config.processing,
            config.numerics,
            params.alpha,
            params.beta,
            params.noise,
            video.denoise,
            video.flat_cleanup,
            video.flat_cleanup_mode,
            video.flat_cleanup_coarse_strength,
            video.flat_cleanup_sigma,
            video.pre_noise_rms,
            video.pre_noise_kind,
            video.pre_noise_masked,
            video.pre_noise_seed,
        )
        if key != self.tone_key:
            self.tone_key = key
            cpu_budget = ColorInputBudget(PREVIEW_COLOR_BYTES)
            cuda_budget = ColorInputBudget(PREVIEW_COLOR_BYTES)
            self.tone_maps = {
                timestamp: _PreviewToneMaps(
                    cpu=ToneMapSlot(color_budget=cpu_budget),
                    cuda=ToneMapSlot(color_budget=cuda_budget),
                )
                for timestamp in timestamps
            }
        return self.tone_maps

    def decode(self, config: Config, timestamp: float):
        frame = self.frames.get(timestamp)
        if frame is None:
            frame = decoded_sample(self.source, config, timestamp, stream=self.stream)
            if self.bytes_used + frame.nbytes <= PREVIEW_CACHE_BYTES:
                self.frames[timestamp] = frame
                self.bytes_used += frame.nbytes
        return frame


class _PreviewCuda:
    """Warm once in the background, then reuse CUDA across isolated samples."""

    def __init__(self):
        self.core: CudaCore | None = None
        self.shape = None

    @staticmethod
    def settings(config: Config):
        return replace(
            config,
            video=replace(
                config.video,
                gpu_iterations=None,
                lighting_scale=1.0,
                gpu_buffer_reuse=True,
                gpu_cleanup_graph=False,
            ),
        )

    def warm(self):
        try:
            core = CudaCore()
            # Use the reference boundary sweep for preview color agreement.
            core.solver.parallel_edge = False
            probe = np.random.default_rng(0).integers(0, 256, (64, 64, 3), np.uint8)
            core(probe, self.settings(Config()), SourceCleanup(0.75))
            self.clear_history(core)
            self.core = core
        except GPUUnavailable:
            pass

    @staticmethod
    def clear_history(core: CudaCore):
        core.history.clear()
        core.device_masks.clear()
        core.host_rings.clear()
        core.pending_history.clear()

    def filter(self, frame: np.ndarray, config: Config, treatment, *, tone_map=None):
        core = self.core
        if core is None:
            raise GPUUnavailable("CUDA preview is unavailable")
        if self.shape != frame.shape:
            for cache in (
                core.buffers,
                core.axes,
                core.resize_axes,
                core.mask_axes,
                core.noise_fields,
            ):
                cache.clear()
            self.shape = frame.shape
        try:
            result = core(frame, self.settings(config), treatment, tone_map=tone_map)
        except GPUUnavailable:
            self.core = None
            raise
        self.clear_history(core)
        # Keep only the current solver graph and noise field across edits.
        while len(core.solver.graphs) > 1:
            del core.solver.graphs[next(iter(core.solver.graphs))]
        while len(core.noise_fields) > 1:
            del core.noise_fields[next(iter(core.noise_fields))]
        return result


def preview_frame(
    source: Path,
    config: Config,
    timestamp: float,
    *,
    cuda: _PreviewCuda | None = None,
) -> Image.Image:
    """Use the video color/geometry path and independently initialized treatment."""
    return _filter_preview(decoded_sample(source, config, timestamp), config, cuda)


def _filter_preview(
    frame: np.ndarray,
    config: Config,
    cuda: _PreviewCuda | None,
    tone_maps: _PreviewToneMaps | None = None,
):
    if config.parameters.fade == 100:
        return Image.fromarray(frame)
    if (
        cuda is not None
        and cuda.core is not None
        and config.video.filter_backend == "auto"
    ):
        try:
            return Image.fromarray(
                cuda.filter(
                    frame,
                    config,
                    _preview_treatment(config),
                    tone_map=None if tone_maps is None else tone_maps.cuda,
                )
            )
        except GPUUnavailable:
            pass
    result = process_pixels(
        frame,
        int(config.filter[-1]),
        config.parameters,
        config.processing,
        config.numerics,
        source_cleanup=_preview_treatment(config),
        tone_map=None if tone_maps is None else tone_maps.cpu,
    )
    return Image.fromarray(result)


def _preview_treatment(config: Config):
    settings = config.video
    treatment = None
    if settings.flat_cleanup:
        treatment = (
            MultiscaleSourceCleanup(
                fine_strength=settings.flat_cleanup,
                coarse_strength=settings.flat_cleanup_coarse_strength,
                sigma=settings.flat_cleanup_sigma,
            )
            if settings.flat_cleanup_mode == "multiscale"
            else SourceCleanup(settings.flat_cleanup)
        )
    if settings.pre_noise_rms:
        treatment = SourceNoise(
            rms=settings.pre_noise_rms,
            kind=settings.pre_noise_kind,
            masked=settings.pre_noise_masked,
            seed=settings.pre_noise_seed,
            source_cleanup=treatment,
        )
    if settings.denoise:
        treatment = SourceDenoise(settings.denoise, source_cleanup=treatment)
    return treatment


def signal_metrics(frame: np.ndarray, previous: np.ndarray | None = None) -> dict:
    """Measure normalized RGB8 pixels, without interpreting deltas as optical flow."""
    rgb = frame.astype(np.float32)
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    histogram = np.histogram(luma, bins=32, range=(0, 256))[0]
    return dict(
        rgb=rgb.mean(axis=(0, 1)).tolist(),
        luma=float(luma.mean()),
        contrast=float(luma.std()),
        delta=None
        if previous is None
        else float(np.abs(rgb - previous.astype(np.float32)).mean()),
        dark=float(np.mean(luma < 5) * 100),
        bright=float(np.mean(luma >= 250) * 100),
        detail=float(
            (
                np.abs(np.diff(luma, axis=0)).mean()
                + np.abs(np.diff(luma, axis=1)).mean()
            )
            / 2
        ),
        histogram=(histogram / luma.size * 100).tolist(),
    )


class Workbench:
    def __init__(self, directory: Path, presets: Path):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(32)
        self.presets = {
            path.stem: Config.load(path).to_dict()
            for path in sorted(presets.glob("*.yaml"))
        }
        if not self.presets:
            self.presets = {"default": Config().to_dict()}
        self.jobs: dict[str, dict] = {}
        self.job_started: dict[str, float] = {}
        self.uploads: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.active_job: str | None = None
        self.preview_samples: _PreviewSamples | None = None
        self.preview_bitmaps: dict[str, bytes] = {}
        self.preview_cuda = _PreviewCuda()

    @property
    def busy(self):
        return self.active_job is not None

    def submit(self, kind: str, data: dict) -> str:
        config = Config.from_dict(data["config"])
        if config.filter == "both":
            raise ValueError("Choose one Fattal filter for video")
        upload = self.uploads[data["upload"]]
        with self.lock:
            if self.active_job is not None:
                active = self.jobs[self.active_job]
                if active["kind"] != "preview":
                    raise ValueError("Another operation is still running")
                active["state"] = "superseded"
            identifier = uuid4().hex
            self.active_job = identifier
            if kind == "preview":
                self.preview_bitmaps.clear()
            self.job_started[identifier] = time.monotonic()
            self.jobs[identifier] = dict(
                state="running",
                completed=0,
                total=16 if kind == "analyze" else 5 if kind == "preview" else None,
                kind=kind,
            )
            self.executor.submit(self.run, identifier, kind, upload, config)
        return identifier

    def is_active(self, identifier: str):
        with self.lock:
            return identifier == self.active_job

    def update(self, identifier: str, **values):
        with self.lock:
            if identifier != self.active_job:
                return
            job = self.jobs[identifier]
            job.update(values)
            if job["kind"] == "process":
                elapsed = max(0.0, time.monotonic() - self.job_started[identifier])
                fps = (
                    job["completed"] / elapsed
                    if elapsed > 0 and job["completed"]
                    else None
                )
                remaining = (
                    max(
                        1 if job.get("total_estimated") else 0,
                        job["total"] - job["completed"],
                    )
                    if job["total"] is not None
                    else None
                )
                job.update(
                    elapsed=elapsed,
                    fps=fps,
                    eta=remaining / fps if fps and remaining is not None else None,
                )
            if job["state"] in ("done", "error"):
                self.active_job = None

    def run_preview(self, identifier: str, folder: Path, upload: dict, config: Config):
        source = upload["path"]
        samples = self.preview_samples
        if samples is None or samples.key != _PreviewSamples.key_for(source, config):
            samples = _PreviewSamples(source, config)
            self.preview_samples = samples
        dimensions, _, _ = _geometry(samples.stream)
        timestamps = sample_times(upload["duration"])
        tone_maps = samples.tone_maps_for(config, timestamps)
        frames: list[_PreviewFrame] = [
            {"time": timestamp, "width": dimensions[0], "height": dimensions[1]}
            for timestamp in timestamps
        ]
        cuda = (
            self.preview_cuda
            if config.video.filter_backend == "auto"
            and self.preview_cuda.core is not None
            else None
        )
        self.update(identifier, frames=frames)
        remaining_bytes = PREVIEW_BITMAP_BYTES

        def publish(index: int, image: Image.Image):
            nonlocal frames, remaining_bytes
            if not self.is_active(identifier):
                return
            bitmap_size = 54 + ((3 * image.width + 3) & ~3) * image.height
            if bitmap_size <= remaining_bytes:
                buffer = BytesIO()
                image.save(buffer, format="BMP")
                payload = buffer.getvalue()
                url = f"/media/{identifier}/full-{index}.bmp"
                with self.lock:
                    if self.active_job != identifier:
                        return
                    self.preview_bitmaps[url] = payload
                remaining_bytes -= len(payload)
            else:
                # Retain all five previews without growing the in-memory budget.
                folder.mkdir(exist_ok=True)
                filename = f"full-{index}.png"
                image.save(folder / filename, compress_level=1)
                url = f"/media/{identifier}/{filename}"
            # Publish a fresh snapshot after the image is ready to serve.
            frames = frames.copy()
            frames[index] = {
                "time": timestamps[index],
                "url": url,
                "width": image.width,
                "height": image.height,
            }
            self.update(identifier, completed=index + 1, frames=frames)

        def render(timestamp: float, frame: np.ndarray):
            nonlocal cuda
            if not self.is_active(identifier):
                return None
            image = _filter_preview(frame, config, cuda, tone_maps[timestamp])
            if cuda is not None and cuda.core is None:
                for slots in tone_maps.values():
                    slots.cuda.value = None
                    slots.cuda.color_inputs = None
                cuda = None
            return image

        cpu_workers = min(3, os.cpu_count() or 1)
        if (
            cuda is None
            and cpu_workers > 1
            and config.parameters.fade < 100
            and all(timestamp in samples.frames for timestamp in timestamps)
        ):
            # Give the first sample the full CPU before sharing work.
            first = render(timestamps[0], samples.frames[timestamps[0]])
            if first is None:
                return
            publish(0, first)
            if not self.is_active(identifier):
                return
            with ThreadPoolExecutor(
                max_workers=cpu_workers, thread_name_prefix="preview-filter"
            ) as workers:
                pending = [
                    workers.submit(render, timestamp, samples.frames[timestamp])
                    for timestamp in timestamps[1:]
                ]
                try:
                    for index, future in enumerate(pending, start=1):
                        if not self.is_active(identifier):
                            return
                        image = future.result()
                        if image is None:
                            return
                        publish(index, image)
                finally:
                    for future in pending:
                        future.cancel()
        else:
            # Decode the next sample while the job worker filters this one.
            with ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="preview-decode"
            ) as io:
                decoding = io.submit(samples.decode, config, timestamps[0])
                try:
                    for index, timestamp in enumerate(timestamps):
                        if not self.is_active(identifier):
                            return
                        frame = decoding.result()
                        if not self.is_active(identifier):
                            return
                        if index + 1 < len(timestamps):
                            decoding = io.submit(
                                samples.decode, config, timestamps[index + 1]
                            )
                        image = render(timestamp, frame)
                        if image is None:
                            return
                        publish(index, image)
                finally:
                    decoding.cancel()
        self.update(identifier, state="done")

    def run(self, identifier: str, kind: str, upload: dict, config: Config):
        folder = self.directory / identifier
        try:
            if not self.is_active(identifier):
                return
            if kind != "preview":
                folder.mkdir()
            if kind == "analyze":
                samples = []
                previous = None
                for index in range(16):
                    timestamp = upload["duration"] * (index + 0.5) / 16
                    frame = decoded_sample(
                        upload["path"], Config(), timestamp, max_edge=128
                    )
                    samples.append(
                        dict(time=timestamp, **signal_metrics(frame, previous))
                    )
                    previous = frame
                    self.update(
                        identifier,
                        completed=index + 1,
                        analysis=dict(
                            samples=list(samples),
                            duration=upload["duration"],
                            dimensions=list(frame.shape[1::-1]),
                        ),
                    )
                self.update(identifier, state="done")
            elif kind == "preview":
                self.run_preview(identifier, folder, upload, config)
            else:
                estimate = None
                try:
                    stream = upload.get("stream") or _probe(upload["path"], "ffprobe")
                    rate = (
                        _source_rate(stream, config.video)
                        if config.video.frame_rate == "auto"
                        else Fraction(config.video.frame_rate)
                    )
                    estimate = max(1, round(upload["duration"] * float(rate)))
                except (ValueError, OSError, subprocess.SubprocessError, OverflowError):
                    pass

                def report_progress(count, total):
                    self.update(
                        identifier,
                        completed=count,
                        total=total if total is not None else estimate,
                        total_estimated=total is None and estimate is not None,
                    )

                record = process_video(
                    upload["path"],
                    folder / "processed.mp4",
                    config=config,
                    on_progress=report_progress,
                )
                self.update(
                    identifier,
                    state="done",
                    url=f"/media/{identifier}/processed.mp4",
                    metadata=f"/media/{identifier}/processed.meta.json",
                    encoder=record["encoding"]["encoder"],
                )
        except Exception as error:
            self.update(identifier, state="error", error=str(error))


class Handler(BaseHTTPRequestHandler):
    @property
    def app(self) -> Workbench:
        return cast(Server, self.server).workbench

    def log_message(self, format, *args):
        pass

    def send_json(self, value, status=200):
        body = json.dumps(value, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        parts = urlsplit(self.path)
        token = parse_qs(parts.query).get("token", [""])[0]
        expected_host = f"127.0.0.1:{cast(Server, self.server).server_port}"
        origin = self.headers.get("Origin")
        return (
            self.headers.get("Host") == expected_host
            and (origin is None or origin == f"http://{expected_host}")
            and hmac.compare_digest(token.encode(), self.app.token.encode())
        )

    def do_GET(self):
        if not self.authorized():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        path = urlsplit(self.path).path
        app = self.app
        if path == "/api/presets":
            self.send_json(app.presets)
        elif path.startswith("/api/jobs/"):
            with app.lock:
                job = app.jobs.get(path.rsplit("/", 1)[-1], {}).copy()
            self.send_json(job, 200 if job else 404)
        else:
            if path.startswith("/media/"):
                with app.lock:
                    bitmap = app.preview_bitmaps.get(path)
                if bitmap is not None:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/bmp")
                    self.send_header("Content-Length", str(len(bitmap)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.end_headers()
                    try:
                        self.wfile.write(bitmap)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                target = app.directory / path.removeprefix("/media/")
                root = app.directory
            else:
                target = STATIC / ("index.html" if path == "/" else path.lstrip("/"))
                root = STATIC
                if target.suffix not in (".html", ".css", ".js", ".png", ".ttf"):
                    self.send_error(404)
                    return
            if (
                not target.resolve().is_relative_to(root.resolve())
                or not target.is_file()
            ):
                self.send_error(404)
                return
            self.send_file(target)

    def send_file(self, target):
        size = target.stat().st_size
        start, end, status = 0, size - 1, 200
        requested = self.headers.get("Range")
        if requested:
            try:
                unit, bounds = requested.split("=")
                first, last = bounds.split("-")
                if unit != "bytes" or "," in bounds:
                    raise ValueError
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                else:
                    start = max(0, size - int(last))
                if start < 0 or start > end or start >= size:
                    raise ValueError
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(status)
        self.send_header(
            "Content-Type",
            "font/ttf"
            if target.suffix.lower() == ".ttf"
            else mimetypes.guess_type(target)[0] or "application/octet-stream",
        )
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with target.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            try:
                while remaining:
                    block = source.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        if not self.authorized():
            self.send_error(403)
            return
        app = self.app
        path = urlsplit(self.path).path
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= (20 * 1024**3 if path == "/api/upload" else 1024**2):
                raise ValueError("Request is empty or too large")
            if path == "/api/upload":
                identifier = uuid4().hex
                folder = app.directory / identifier
                folder.mkdir()
                target = folder / "source.mp4"
                try:
                    with target.open("xb") as destination:
                        remaining = length
                        while remaining:
                            block = self.rfile.read(min(1024 * 1024, remaining))
                            if not block:
                                raise ValueError("Upload interrupted")
                            destination.write(block)
                            remaining -= len(block)
                    stream = _probe(target, "ffprobe")
                    duration = float(stream.get("duration", 0))
                    if duration <= 0:
                        report = subprocess.run(
                            [
                                "ffprobe",
                                "-v",
                                "error",
                                "-show_entries",
                                "format=duration",
                                "-of",
                                "json",
                                str(target),
                            ],
                            capture_output=True,
                            check=True,
                            timeout=30,
                        )
                        duration = float(
                            json.loads(report.stdout)["format"]["duration"]
                        )
                    sample_times(duration)
                    app.uploads[identifier] = dict(
                        path=target, duration=duration, stream=stream
                    )
                    self.send_json(
                        dict(
                            upload=identifier,
                            duration=duration,
                            width=stream["width"],
                            height=stream["height"],
                            url=f"/media/{identifier}/source.mp4",
                        )
                    )
                except Exception:
                    shutil.rmtree(folder)
                    raise
            elif path == "/api/import":
                content = self.rfile.read(length).decode()
                if self.headers.get_content_type() == "application/json":
                    request = Config._parse_data(content, ".json")
                    if not isinstance(request, dict) or "files" not in request:
                        config = Config.from_dict(request)
                        if config.filter == "both":
                            raise ValueError(
                                "Choose fattal1 or fattal2 for a video recipe"
                            )
                        self.send_json(config.to_dict())
                        return
                    files = request["files"]
                    filename = request["filename"]
                    if (
                        not isinstance(files, dict)
                        or not files
                        or not all(
                            isinstance(name, str) and isinstance(text, str)
                            for name, text in files.items()
                        )
                        or not isinstance(filename, str)
                    ):
                        raise ValueError("Import requires named configuration files")
                    try:
                        config = Config.from_sources(filename, files)
                    except FileNotFoundError as error:
                        self.send_json(
                            dict(error=str(error), missing_source=error.filename), 400
                        )
                        return
                else:
                    data = yaml.load(content, Loader=_ConfigLoader)
                    config = Config.from_dict(data)
                if config.filter == "both":
                    raise ValueError("Choose fattal1 or fattal2 for a video recipe")
                self.send_json(config.to_dict())
            elif path == "/api/config":
                config = Config.from_dict(json.loads(self.rfile.read(length)))
                self.send_json(config.to_dict())
            elif path in ("/api/preview", "/api/process", "/api/analyze"):
                data = json.loads(self.rfile.read(length))
                self.send_json(dict(job=app.submit(path.rsplit("/", 1)[-1], data)))
            else:
                self.send_error(404)
        except (
            ValueError,
            TypeError,
            KeyError,
            OSError,
            yaml.YAMLError,
            subprocess.SubprocessError,
        ) as error:
            self.send_json(dict(error=str(error)), 400)


class Server(ThreadingHTTPServer):
    def __init__(self, port: int, workbench: Workbench):
        self.workbench = workbench
        super().__init__(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(
        description="Open the local Luma Fattal video workbench"
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--presets", type=Path, default=REPOSITORY / "configs")
    parser.add_argument("--output-dir", type=Path, default=Path("outputs/ui"))
    args = parser.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            parser.error(f"Install {tool} before starting the UI")
    directory = args.output_dir / uuid4().hex
    app = Workbench(directory, args.presets)
    server = Server(args.port, app)
    threading.Thread(
        target=app.preview_cuda.warm, name="preview-cuda-warmup", daemon=True
    ).start()
    url = f"http://127.0.0.1:{server.server_port}/?token={app.token}"
    print(f"Luma Fattal: {url}\nSession files: {directory.resolve()}", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.executor.shutdown(wait=True)


if __name__ == "__main__":
    main()
