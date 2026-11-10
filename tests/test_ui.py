"""Workbench contracts with controlled media and isolated session directories."""

import json
import shutil
import subprocess
import time

import numpy as np
import pytest
from PIL import Image
from test_video import tools as tools

from luma_fattal import Config, FilterParams
from luma_fattal.ui.server import (
    REPOSITORY,
    Workbench,
    preview_frame,
    sample_times,
    thumbnail_config,
)
from luma_fattal.video import _decode_command, _geometry, _probe, _resolve_color


def test_gui_controls_cover_every_configuration_field():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is needed to inspect GUI control definitions")
    script = REPOSITORY / "src/luma_fattal/ui/settings.js"
    definitions = json.loads(
        subprocess.run(
            [
                node,
                "-e",
                "process.stdout.write(JSON.stringify(require(process.argv[1]).settingGroups))",
                str(script),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )
    defaults = Config().to_dict()
    expected = {
        (section, key)
        for section, values in defaults.items()
        if isinstance(values, dict)
        for key in values
    }
    actual = [(section, item[0]) for section, _, items in definitions for item in items]
    assert len(actual) == len(set(actual))
    assert set(actual) == expected
    for section, _, items in definitions:
        for key, _, control, *rest in items:
            if isinstance(control, list):
                for choice in control:
                    candidate = Config().to_dict()
                    candidate[section][key] = choice
                    Config.from_dict(candidate)


def test_samples_cover_equal_segments_without_eof():
    assert sample_times(10) == [1, 3, 5, 7, 9]
    assert all(0 < value < 0.01 for value in sample_times(0.01))
    for duration in (0, -1, float("inf"), float("nan")):
        with pytest.raises(ValueError):
            sample_times(duration)


def test_preview_fade_bypass_matches_normalized_video_frame(tmp_path, tools):
    from test_video import make_clip

    source = tmp_path / "source.mp4"
    make_clip(source, tools)
    config = Config(parameters=FilterParams(fade=100))
    stream = _probe(source, tools[1])
    dimensions, rotation, _ = _geometry(stream)
    color, _ = _resolve_color(stream, config.video)
    command = _decode_command(
        tools[0], source, stream, color=color, dimensions=dimensions, rotation=rotation
    )
    command[-1:-1] = ["-frames:v", "1"]
    import subprocess

    raw = subprocess.run(command, capture_output=True, check=True).stdout
    reference = np.frombuffer(raw, np.uint8).reshape(dimensions[1], dimensions[0], 3)
    np.testing.assert_array_equal(
        np.asarray(preview_frame(source, config, 0)), reference
    )


def test_workbench_preview_render_and_progress(tmp_path, tools):
    from test_video import make_clip

    source = tmp_path / "source.mp4"
    make_clip(source, tools)
    app = Workbench(tmp_path / "session", REPOSITORY / "configs")
    config = Config(parameters=FilterParams(fade=100))
    app.uploads["test"] = dict(path=source, duration=0.2)
    try:
        for kind in ("preview", "process"):
            identifier = app.submit(kind, dict(upload="test", config=config.to_dict()))
            deadline = time.monotonic() + 60
            while app.busy and time.monotonic() < deadline:
                time.sleep(0.02)
            job = app.jobs[identifier]
            assert job["state"] == "done", job
            if kind == "preview":
                assert job["completed"] == job["total"] == 10
                for frame in job["frames"]:
                    with Image.open(
                        app.directory / frame["url"].removeprefix("/media/")
                    ) as image:
                        image.verify()
            else:
                output = app.directory / job["url"].removeprefix("/media/")
                assert _probe(output, tools[1])["codec_name"] == "h264"
                record = json.loads(output.with_suffix(".meta.json").read_text())
                assert job["completed"] == record["frame_count"]
    finally:
        app.executor.shutdown()


def test_workbench_rejects_invalid_config_and_retains_source(tmp_path):
    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["test"] = dict(path=tmp_path / "source.mp4", duration=1)
    try:
        invalid = Config().to_dict()
        invalid["parameters"]["black_level"] = 100
        with pytest.raises(ValueError, match="black_level"):
            app.submit("preview", dict(upload="test", config=invalid))
        assert not app.busy
        assert not app.jobs
    finally:
        app.executor.shutdown()


def test_http_auth_import_ranges_and_path_boundaries(tmp_path, monkeypatch):
    import io
    from socket import socket
    from types import SimpleNamespace
    from typing import cast

    from luma_fattal.ui.server import Handler, Server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    server = cast(Server, SimpleNamespace(workbench=app, server_port=8765))

    class Connection:
        def __init__(self, request):
            self.request = io.BytesIO(request)
            self.response = io.BytesIO()

        def makefile(self, *_):
            return self.request

        def sendall(self, data):
            self.response.write(data)

    def request(path, *, method="GET", body=b"", headers="", token=True):
        separator = "&" if "?" in path else "?"
        target = path + (f"{separator}token={app.token}" if token else "")
        raw = (
            f"{method} {target} HTTP/1.0\r\nHost: 127.0.0.1:8765\r\nContent-Length: {len(body)}\r\n{headers}\r\n".encode()
            + body
        )
        connection = Connection(raw)
        Handler(cast(socket, connection), ("127.0.0.1", 1), server)
        head, result = connection.response.getvalue().split(b"\r\n\r\n", 1)
        return head, result

    try:
        assert b"403" in request("/api/presets", token=False)[0]
        assert (
            b"403"
            in request("/api/presets", headers="Origin: https://example.com\r\n")[0]
        )
        assert b"404" in request("/media/../../pyproject.toml")[0]
        assert b"404" in request("/server.py")[0]
        assert b"200" in request("/")[0]
        assert b"200" in request("/settings.js")[0]
        assert b"403" in request("/settings.js", token=False)[0]
        with monkeypatch.context() as patch:
            patch.setattr("mimetypes.guess_type", lambda *_: (None, None))
            head, body = request("/assets/Arimo-Regular.ttf")
        assert b"200" in head and b"font/ttf" in head
        assert body.startswith(b"\x00\x01\x00\x00")
        assert b"403" in request("/assets/Arimo-Regular.ttf", token=False)[0]
        head, body = request(
            "/api/import",
            method="POST",
            body=b"filter: fattal2\nparameters:\n  beta: 70\nvideo:\n  deblock: off\n",
        )
        assert b"200" in head
        assert json.loads(body)["parameters"]["beta"] == 70
        assert json.loads(body)["video"]["deblock"] == "off"
        head, body = request(
            "/api/import",
            method="POST",
            body=b'{"filter":"fattal2"}',
            headers="Content-Type: application/json\r\n",
        )
        assert b"200" in head and json.loads(body)["filter"] == "fattal2"
        assert (
            b"400"
            in request(
                "/api/import",
                method="POST",
                body=b'{"filter":"fattal1","filter":"fattal2"}',
                headers="Content-Type: application/json\r\n",
            )[0]
        )
        assert (
            b"400"
            in request(
                "/api/import", method="POST", body=b"filter: fattal1\nfilter: fattal2"
            )[0]
        )
        assert b"400" in request("/api/import", method="POST", body=b"filter: both")[0]
        sources = {
            "filename": "recipe.toml",
            "files": {
                "recipe.toml": 'extends = "base.json"\n[video]\npre_noise_rms = 0.75'
            },
        }
        head, body = request(
            "/api/import",
            method="POST",
            body=json.dumps(sources).encode(),
            headers="Content-Type: application/json\r\n",
        )
        assert b"400" in head
        assert json.loads(body)["missing_source"] == "base.json"
        sources["files"]["base.json"] = '{"video":{"pre_noise_kind":"fbm"}}'
        head, body = request(
            "/api/import",
            method="POST",
            body=json.dumps(sources).encode(),
            headers="Content-Type: application/json\r\n",
        )
        assert b"200" in head
        imported = json.loads(body)
        assert imported["video"]["pre_noise_kind"] == "fbm"
        assert imported["video"]["pre_noise_rms"] == 0.75
        head, body = request(
            "/api/config", method="POST", body=json.dumps(imported).encode()
        )
        assert b"200" in head and json.loads(body) == imported
        imported["parameters"]["alpha"] = 0
        assert (
            b"400"
            in request(
                "/api/config", method="POST", body=json.dumps(imported).encode()
            )[0]
        )
        assert (
            b"400"
            in request("/api/import", method="POST", body=b"inherits: /etc/passwd")[0]
        )
        media = app.directory / "clip.mp4"
        media.write_bytes(b"0123456789")
        head, body = request("/media/clip.mp4", headers="Range: bytes=2-5\r\n")
        assert b"206" in head and body == b"2345"
        assert b"Content-Range: bytes 2-5/10" in head
        assert request("/media/clip.mp4", headers="Range: bytes=-3\r\n")[1] == b"789"
        assert b"416" in request("/media/clip.mp4", headers="Range: bytes=30-\r\n")[0]
    finally:
        app.executor.shutdown()


def test_signal_metrics_measure_constant_and_changing_pixels():
    from luma_fattal.ui.server import signal_metrics

    black = np.zeros((4, 4, 3), np.uint8)
    record = signal_metrics(black)
    assert record["rgb"] == [0, 0, 0]
    assert record["luma"] == record["contrast"] == record["detail"] == 0
    assert record["dark"] == 100 and record["bright"] == 0
    assert record["histogram"] == [100] + [0] * 31
    assert record["delta"] is None
    white = np.full_like(black, 255)
    record = signal_metrics(white, black)
    assert record["delta"] == 255
    assert record["bright"] == 100 and record["dark"] == 0
    assert record["histogram"] == [0] * 31 + [100]
    split = black.copy()
    split[:, 2:] = 255
    record = signal_metrics(split)
    assert record["contrast"] == pytest.approx(127.5)
    assert record["detail"] == pytest.approx(42.5)


def test_clip_analysis_is_bounded_and_uses_real_source_samples(tmp_path, tools):
    from test_video import make_clip

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    source = make_clip(tmp_path / "signal.mkv", tools, width=256, height=192)
    app.uploads["test"] = dict(path=source, duration=0.2)
    try:
        identifier = app.submit(
            "analyze", dict(upload="test", config=Config().to_dict())
        )
        deadline = time.monotonic() + 60
        while app.busy and time.monotonic() < deadline:
            time.sleep(0.02)
        job = app.jobs[identifier]
        assert job["state"] == "done", job
        assert job["completed"] == job["total"] == 16
        analysis = job["analysis"]
        assert analysis["dimensions"] == [128, 96]
        samples = analysis["samples"]
        assert len(samples) == 16
        assert samples[0]["delta"] is None
        assert any(sample["delta"] > 0 for sample in samples[1:])
        assert all(0 < sample["time"] < 0.2 for sample in samples)
        assert all(sum(sample["histogram"]) == pytest.approx(100) for sample in samples)
        json.dumps(analysis, allow_nan=False)
    finally:
        app.executor.shutdown()


def test_processing_rate_and_eta_use_elapsed_job_time(tmp_path, monkeypatch):
    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    try:
        app.active_job = "render"
        app.jobs["render"] = dict(
            kind="process", state="running", completed=0, total=None
        )
        app.job_started["render"] = 100.0
        monkeypatch.setattr("luma_fattal.ui.server.time.monotonic", lambda: 100.0)
        app.update("render", completed=0)
        assert app.jobs["render"]["fps"] is None
        assert app.jobs["render"]["eta"] is None
        monkeypatch.setattr("luma_fattal.ui.server.time.monotonic", lambda: 110.0)
        app.update("render", completed=250, total=1000)
        assert app.jobs["render"]["fps"] == 25.0
        assert app.jobs["render"]["eta"] == 30.0
        monkeypatch.setattr("luma_fattal.ui.server.time.monotonic", lambda: 140.0)
        app.update("render", completed=1000)
        assert app.jobs["render"]["eta"] == 0.0
    finally:
        app.executor.shutdown()


def test_preview_reduces_frame_before_processing(tmp_path, monkeypatch):
    from luma_fattal.ui import server

    calls = []
    small = np.zeros((144, 256, 3), np.uint8)

    def decode(source, config, timestamp, max_edge=None):
        calls.append(max_edge)
        return small

    def process(frames, **kwargs):
        frame = next(iter(frames))
        assert frame.shape == (144, 256, 3)
        yield frame

    monkeypatch.setattr(server, "decoded_sample", decode)
    monkeypatch.setattr(server, "process_frames", process)
    assert preview_frame(tmp_path / "source.mp4", Config(), 1, max_edge=256).size == (
        256,
        144,
    )
    assert calls == [256]


@pytest.mark.parametrize("variant", (1, 2))
@pytest.mark.parametrize("relaxation", (1.0, 1.5, 1.9))
def test_thumbnail_is_closer_to_full_result(variant, relaxation):
    from dataclasses import replace

    from luma_fattal.pipeline import apply_filter

    # A smooth scene, fine texture and a sharp colored object exercise both
    # large-scale reconstruction and multiscale attenuation.
    height, width = 432, 768
    y, x = np.mgrid[:height, :width].astype(float)
    x /= width
    y /= height
    light = 0.3 + 0.2 * np.sin(8 * x) + 0.2 * y
    light += 0.04 * np.sin(270 * x) * np.sin(190 * y)
    scene = np.stack(
        (
            light + 0.08 * np.sin(37 * y),
            light * 0.8 + 0.1 * x,
            light * 0.7 + 0.1 * np.cos(17 * x),
        ),
        axis=-1,
    )
    scene[(x - 0.65) ** 2 + (y - 0.4) ** 2 < 0.12**2] = (0.85, 0.4, 0.15)
    source = np.clip(scene * 255, 0, 255).astype(np.uint8)
    config = Config(filter=f"fattal{variant}")
    config = replace(config, numerics=replace(config.numerics, relaxation=relaxation))
    size = (128, 72)
    small = np.asarray(Image.fromarray(source).resize(size, Image.Resampling.BICUBIC))
    reference = np.asarray(
        Image.fromarray(apply_filter(source, config=config)).resize(
            size, Image.Resampling.LANCZOS
        )
    ).astype(float)
    original = apply_filter(small, config=config)
    adjusted = apply_filter(
        small, config=thumbnail_config(config, (width, height), 128)
    )
    original_error = np.abs(original.astype(float) - reference).mean()
    adjusted_error = np.abs(adjusted.astype(float) - reference).mean()
    assert adjusted_error < original_error * 0.6


def test_thumbnail_uses_effective_working_resolution(set_size_limits):
    from dataclasses import replace

    config = Config()
    # Both sources reach the same working grid before filtering.
    assert thumbnail_config(config, (1920, 1080), 256) == thumbnail_config(
        config, (3840, 2160), 256
    )
    before = config.to_dict()
    adjusted = thumbnail_config(config, (1920, 1080), 256)
    assert config.to_dict() == before
    assert adjusted.parameters == config.parameters
    assert adjusted.processing == config.processing
    assert adjusted.video == config.video
    assert adjusted.numerics.iterations == config.numerics.iterations
    assert thumbnail_config(config, (256, 144), 256) is config
    set_size_limits(512)
    bounded = thumbnail_config(config, (1920, 1080), 256)
    set_size_limits(4096, pixels=512 * 288)
    assert thumbnail_config(config, (1920, 1080), 256).numerics == bounded.numerics
    set_size_limits(128)
    assert thumbnail_config(config, (1920, 1080), 256) is config
    bypass = replace(config, parameters=FilterParams(fade=100))
    assert thumbnail_config(bypass, (1920, 1080), 256) is bypass


@pytest.mark.parametrize("size", ((1920, 1200), (1024, 1024), (1080, 1920)))
def test_thumbnail_preserves_attenuation_depth(size):
    from luma_fattal.core import _pyramid
    from luma_fattal.processing import working_size

    config = Config()
    adjusted = thumbnail_config(config, size, 256)
    full_size = working_size(size, config.processing.effective_max_edge)
    small_size = working_size(size, 256)
    full = np.zeros(full_size[::-1], np.float32)
    small = np.zeros(small_size[::-1], np.float32)
    assert len(_pyramid(small, adjusted.numerics.pyramid_min_size)) == len(
        _pyramid(full, config.numerics.pyramid_min_size)
    )


def test_preview_publishes_all_thumbnails_before_full_frames(tmp_path, monkeypatch):
    import threading

    from luma_fattal.ui import server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["test"] = dict(path=tmp_path / "source.mp4", duration=10)
    entered_full = threading.Event()
    resume = threading.Event()
    calls = []
    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((1920, 1080), 0, 1))

    def frame(source, config, timestamp, max_edge=None):
        calls.append((timestamp, max_edge))
        if max_edge is not None:
            assert config.numerics.relaxation < Config().numerics.relaxation
        else:
            assert config == Config()
        if max_edge is None:
            entered_full.set()
            assert resume.wait(10)
        return Image.new("RGB", (256, 144) if max_edge else (1920, 1080))

    monkeypatch.setattr(server, "preview_frame", frame)
    try:
        identifier = app.submit(
            "preview", dict(upload="test", config=Config().to_dict())
        )
        assert entered_full.wait(10)
        snapshot = app.jobs[identifier].copy()
        assert snapshot["state"] == "running"
        assert snapshot["completed"] == 5
        assert [timestamp for timestamp, _ in calls[:5]] == sample_times(10)
        assert all(edge == 256 for _, edge in calls[:5])
        for item in snapshot["frames"]:
            assert "full" not in item
            assert item["width"] == 1920 and item["height"] == 1080
            with Image.open(
                app.directory / item["thumbnail"].removeprefix("/media/")
            ) as image:
                assert image.size == (256, 144)
        resume.set()
        app.executor.shutdown()
        job = app.jobs[identifier]
        assert job["state"] == "done"
        assert job["completed"] == job["total"] == 10
        assert all("full" not in item for item in snapshot["frames"])
        for item in job["frames"]:
            with Image.open(
                app.directory / item["full"].removeprefix("/media/")
            ) as image:
                assert image.size == (1920, 1080)
    finally:
        resume.set()
        app.executor.shutdown()


def test_preview_replacement_skips_stale_frames_and_queued_jobs(tmp_path, monkeypatch):
    import threading

    from luma_fattal.ui import server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["test"] = dict(path=tmp_path / "source.mp4", duration=10)
    entered = threading.Event()
    resume = threading.Event()
    calls = []
    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((32, 24), 0, 1))

    def frame(source, config, timestamp, max_edge=None):
        beta = config.parameters.beta
        calls.append(beta)
        if beta == 80:
            entered.set()
            assert resume.wait(10)
        return Image.new("RGB", (32, 24))

    def submit(beta):
        config = Config(parameters=FilterParams(beta=beta))
        return app.submit("preview", dict(upload="test", config=config.to_dict()))

    monkeypatch.setattr(server, "preview_frame", frame)
    try:
        first = submit(80)
        assert entered.wait(10)
        intermediate = submit(70)
        latest = submit(60)
        assert (
            app.jobs[first]["state"] == app.jobs[intermediate]["state"] == "superseded"
        )
        assert app.jobs[latest]["state"] == "running"
    finally:
        resume.set()
        app.executor.shutdown()

    assert calls == [80, *([60] * 10)]
    assert app.jobs[first]["completed"] == 0
    assert not (app.directory / intermediate).exists()
    assert app.jobs[latest]["state"] == "done"
    assert app.jobs[latest]["completed"] == 10
    assert not app.busy


@pytest.mark.parametrize("width,height", [(512, 288), (288, 512)])
def test_fast_preview_bounds_decoded_resolution(tmp_path, tools, width, height):
    from test_video import make_clip

    source = make_clip(tmp_path / "source.mp4", tools, width=width, height=height)
    image = preview_frame(
        source, Config(parameters=FilterParams(fade=100)), 0, max_edge=256
    )
    assert image.size == (width // 2, height // 2)
