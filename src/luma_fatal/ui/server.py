"""Loopback-only UI server. Media and jobs stay in a private session directory."""

from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import secrets
import shutil
import subprocess
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import numpy as np
import yaml
from PIL import Image

from ..cleanup import MultiscaleSourceCleanup, SourceCleanup
from ..configuration import Config, _ConfigLoader
from ..denoise import SourceDenoise
from ..pipeline import process_frames
from ..prenoise import SourceNoise
from ..video import (
    _decode_command,
    _geometry,
    _probe,
    _resolve_color,
    process_video,
)

STATIC = Path(__file__).parent
REPOSITORY = STATIC.parents[2]


def sample_times(duration: float) -> list[float]:
    """Sample the centers of five equal-duration segments, avoiding the EOF edge."""
    if not np.isfinite(duration) or duration <= 0:
        raise ValueError("Video duration must be finite and positive")
    return [duration * (index + 0.5) / 5 for index in range(5)]


def decoded_sample(
    source: Path, config: Config, timestamp: float, max_edge: int | None = None
) -> np.ndarray:
    """Decode one color-normalized sample with an optional output size bound."""
    stream = _probe(source, "ffprobe")
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
    # Input seeking avoids decoding the whole clip for every thumbnail.
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


def preview_frame(source: Path, config: Config, timestamp: float) -> Image.Image:
    """Use the video color/geometry path and independently initialized treatment."""
    frame = decoded_sample(source, config, timestamp)
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
    result = next(process_frames([frame], config=config, source_cleanup=treatment))
    return Image.fromarray(result)


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
        self.uploads: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.busy = False

    def submit(self, kind: str, data: dict) -> str:
        config = Config.from_dict(data["config"])
        if config.filter == "both":
            raise ValueError("Choose one Fattal filter for video")
        upload = self.uploads[data["upload"]]
        with self.lock:
            if self.busy:
                raise ValueError("Another operation is still running")
            self.busy = True
            identifier = uuid4().hex
            self.jobs[identifier] = dict(
                state="running",
                completed=0,
                total=16 if kind == "analyze" else 5 if kind == "preview" else None,
                kind=kind,
            )
        self.executor.submit(self.run, identifier, kind, upload, config)
        return identifier

    def update(self, identifier: str, **values):
        with self.lock:
            self.jobs[identifier].update(values)

    def run(self, identifier: str, kind: str, upload: dict, config: Config):
        folder = self.directory / identifier
        folder.mkdir()
        try:
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
                frames = []
                for index, timestamp in enumerate(sample_times(upload["duration"])):
                    filename = f"frame-{index}.png"
                    preview_frame(upload["path"], config, timestamp).save(
                        folder / filename
                    )
                    frames.append(
                        dict(url=f"/media/{identifier}/{filename}", time=timestamp)
                    )
                    self.update(identifier, completed=index + 1)
                self.update(
                    identifier,
                    state="done",
                    frames=frames,
                )
            else:
                record = process_video(
                    upload["path"],
                    folder / "processed.mp4",
                    config=config,
                    on_progress=lambda count, total: self.update(
                        identifier, completed=count, total=total
                    ),
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
        finally:
            with self.lock:
                self.busy = False


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
                target = app.directory / path.removeprefix("/media/")
                root = app.directory
            else:
                target = STATIC / ("index.html" if path == "/" else path.lstrip("/"))
                root = STATIC
                if target.suffix not in (".html", ".css", ".js", ".png"):
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
            mimetypes.guess_type(target)[0] or "application/octet-stream",
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
                    app.uploads[identifier] = dict(path=target, duration=duration)
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
                data = yaml.load(self.rfile.read(length).decode(), Loader=_ConfigLoader)
                config = Config.from_dict(data)
                if config.filter == "both":
                    raise ValueError("Choose fattal1 or fattal2 for a video recipe")
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
