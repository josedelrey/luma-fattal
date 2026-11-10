"""Workbench contracts with controlled media and isolated session directories."""

import json
import shutil
import subprocess
import time
from io import BytesIO

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
                assert job["completed"] == job["total"] == 5
                for frame in job["frames"]:
                    with Image.open(
                        BytesIO(app.preview_bitmaps[frame["url"]])
                    ) as image:
                        image.verify()
                assert not (app.directory / identifier).exists()
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
        bitmap_url = "/media/preview/full-0.bmp"
        buffer = BytesIO()
        Image.new("RGB", (3, 2), (12, 34, 56)).save(buffer, format="BMP")
        app.preview_bitmaps[bitmap_url] = buffer.getvalue()
        assert b"403" in request(bitmap_url, token=False)[0]
        head, body = request(bitmap_url)
        assert b"200" in head and b"image/bmp" in head
        assert body == buffer.getvalue()
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


def test_preview_overlaps_io_and_publishes_in_order(tmp_path, monkeypatch):
    import threading

    from luma_fattal.ui import server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["test"] = dict(path=tmp_path / "source.mp4", duration=10)
    decoded_second = threading.Event()
    entered_second = threading.Event()
    published_first = threading.Event()
    resume = threading.Event()
    calls = []
    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((640, 360), 0, 1))

    def decode(source, config, timestamp, *, stream):
        if timestamp == 3:
            decoded_second.set()
        return np.full((1, 1, 3), int(timestamp), np.uint8)

    def frame(pixels, config, cuda, tone_maps):
        assert config == Config()
        calls.append(int(pixels[0, 0, 0]))
        if len(calls) == 1:
            assert decoded_second.wait(10)
        elif len(calls) == 2:
            entered_second.set()
            assert resume.wait(10)
        return Image.new("RGB", (640, 360), (13, 27, 42))

    original_update = app.update

    def update(identifier, **values):
        original_update(identifier, **values)
        if values.get("completed") == 1:
            published_first.set()

    monkeypatch.setattr(server, "decoded_sample", decode)
    monkeypatch.setattr(server, "_filter_preview", frame)
    monkeypatch.setattr(app, "update", update)
    try:
        identifier = app.submit(
            "preview", dict(upload="test", config=Config().to_dict())
        )
        assert published_first.wait(10)
        assert entered_second.wait(10)
        snapshot = app.jobs[identifier].copy()
        assert snapshot["state"] == "running"
        assert snapshot["completed"] == 1
        assert calls == sample_times(10)[:2]
        assert all("url" not in item for item in snapshot["frames"][1:])
        with Image.open(
            BytesIO(app.preview_bitmaps[snapshot["frames"][0]["url"]])
        ) as image:
            assert image.size == (640, 360)
            assert image.getpixel((0, 0)) == (13, 27, 42)
    finally:
        resume.set()
        app.executor.shutdown()
    job = app.jobs[identifier]
    assert job["state"] == "done"
    assert job["completed"] == job["total"] == 5
    assert calls == sample_times(10)
    assert all("url" in item for item in job["frames"])
    assert all("url" not in item for item in snapshot["frames"][1:])


def test_preview_spills_to_disk_when_bitmap_budget_is_full(tmp_path, monkeypatch):
    from luma_fattal.ui import server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["test"] = dict(path=tmp_path / "source.mp4", duration=10)
    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((3, 2), 0, 1))
    monkeypatch.setattr(server, "PREVIEW_BITMAP_BYTES", 78)
    pixels = np.arange(18, dtype=np.uint8).reshape((2, 3, 3))
    monkeypatch.setattr(server, "decoded_sample", lambda *_, **__: pixels)
    config = Config(parameters=FilterParams(fade=100))
    try:
        previous_url = None
        for _ in range(2):
            identifier = app.submit(
                "preview", dict(upload="test", config=config.to_dict())
            )
            app.executor.submit(lambda: None).result(timeout=10)
            job = app.jobs[identifier]
            assert job["state"] == "done"
            first, *overflow = job["frames"]
            assert list(app.preview_bitmaps) == [first["url"]]
            assert previous_url not in app.preview_bitmaps
            with Image.open(BytesIO(app.preview_bitmaps[first["url"]])) as image:
                np.testing.assert_array_equal(image, pixels)
            for frame in overflow:
                with Image.open(
                    app.directory / frame["url"].removeprefix("/media/")
                ) as image:
                    np.testing.assert_array_equal(image, pixels)
            previous_url = first["url"]
    finally:
        app.executor.shutdown()


def test_warm_cpu_preview_prioritizes_first_frame_and_supersedes_parallel_work(
    tmp_path, monkeypatch
):
    from threading import Event, Lock

    from luma_fattal.ui import server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["test"] = dict(path=tmp_path / "source.mp4", duration=10)
    monkeypatch.setattr(server.os, "cpu_count", lambda: 8)
    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((3, 2), 0, 1))
    monkeypatch.setattr(
        server,
        "decoded_sample",
        lambda source, config, timestamp, **_: np.full(
            (2, 3, 3), int(timestamp), np.uint8
        ),
    )
    first_started, first_release = Event(), Event()
    filters_overlap, filters_release = Event(), Event()
    started = []
    lock = Lock()

    def render(frame, config, cuda, tone_maps):
        timestamp = int(frame[0, 0, 0])
        if config.parameters.beta == 70:
            with lock:
                started.append(timestamp)
                if len(started) >= 3:
                    filters_overlap.set()
            if timestamp == 1:
                first_started.set()
                assert first_release.wait(10)
            else:
                assert filters_release.wait(10)
        return Image.fromarray(frame)

    def submit(params):
        config = Config(parameters=params)
        return app.submit("preview", dict(upload="test", config=config.to_dict()))

    monkeypatch.setattr(server, "_filter_preview", render)
    try:
        initial = submit(FilterParams(fade=100))
        app.executor.submit(lambda: None).result(timeout=10)
        assert app.jobs[initial]["state"] == "done"
        edited = submit(FilterParams(beta=70))
        assert first_started.wait(10)
        with lock:
            assert started == [1]
        first_release.set()
        assert filters_overlap.wait(10)
        assert app.jobs[edited]["completed"] == 1
        assert "url" in app.jobs[edited]["frames"][0]
        latest = submit(FilterParams(beta=60))
        filters_release.set()
        app.executor.submit(lambda: None).result(timeout=10)
        assert app.jobs[edited]["state"] == "superseded"
        assert app.jobs[edited]["completed"] == 1
        assert app.jobs[latest]["state"] == "done"
        for sample in app.jobs[latest]["frames"]:
            with Image.open(BytesIO(app.preview_bitmaps[sample["url"]])) as image:
                assert image.getpixel((0, 0)) == (int(sample["time"]),) * 3
    finally:
        first_release.set()
        filters_release.set()
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

    def frame(pixels, config, cuda, tone_maps):
        beta = config.parameters.beta
        calls.append(beta)
        if beta == 80:
            entered.set()
            assert resume.wait(10)
        return Image.new("RGB", (32, 24))

    def submit(beta):
        config = Config(parameters=FilterParams(beta=beta))
        return app.submit("preview", dict(upload="test", config=config.to_dict()))

    monkeypatch.setattr(
        server, "decoded_sample", lambda *_, **__: np.zeros((24, 32, 3), np.uint8)
    )
    monkeypatch.setattr(server, "_filter_preview", frame)
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

    assert calls == [80] + [60] * 5
    assert app.jobs[first]["completed"] == 0
    assert not (app.directory / intermediate).exists()
    assert app.jobs[latest]["state"] == "done"
    assert app.jobs[latest]["completed"] == 5
    assert not app.busy


def test_preview_reuses_decoded_pixels_until_source_or_decode_settings_change(
    tmp_path, monkeypatch
):
    from dataclasses import replace

    from luma_fattal.ui import server

    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["first"] = dict(path=tmp_path / "first.mp4", duration=10)
    app.uploads["second"] = dict(path=tmp_path / "second.mp4", duration=10)
    probes = []
    decodes = []
    filtered = []
    monkeypatch.setattr(server, "_probe", lambda path, _: probes.append(path) or {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((32, 24), 0, 1))

    def decode(source, config, timestamp, max_edge=None, *, stream=None):
        decodes.append((source, config.video.deband, timestamp, max_edge))
        return np.zeros((24, 32, 3), np.uint8)

    def filter_frame(frame, variant, params, *_, **__):
        filtered.append(params.beta)
        return frame

    def preview(upload, config):
        identifier = app.submit("preview", dict(upload=upload, config=config.to_dict()))
        app.executor.submit(lambda: None).result(timeout=10)
        assert app.jobs[identifier]["state"] == "done", app.jobs[identifier]

    monkeypatch.setattr(server, "decoded_sample", decode)
    monkeypatch.setattr(server, "process_pixels", filter_frame)
    config = Config()
    try:
        preview("first", config)
        assert len(decodes) == 5
        assert len(probes) == 1
        changed_effect = replace(config, parameters=FilterParams(beta=60))
        preview("first", changed_effect)
        assert len(decodes) == 5
        assert len(probes) == 1
        assert filtered == [80] * 5 + [60] * 5

        changed_decode = replace(config, video=replace(config.video, deband="gentle"))
        preview("first", changed_decode)
        assert len(decodes) == 10
        assert all(deband == "gentle" for _, deband, _, _ in decodes[5:])

        preview("second", changed_decode)
        assert len(decodes) == 15
        assert all(
            source == app.uploads["second"]["path"] for source, *_ in decodes[10:]
        )
    finally:
        app.executor.shutdown()


def test_preview_cache_respects_byte_budget(tmp_path, monkeypatch):
    from luma_fattal.ui import server

    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "PREVIEW_CACHE_BYTES", 24)
    monkeypatch.setattr(
        server, "decoded_sample", lambda *_, **__: np.zeros((2, 2, 3), np.uint8)
    )
    config = Config()
    samples = server._PreviewSamples(tmp_path / "source.mp4", config)
    first = samples.decode(config, 1)
    second = samples.decode(config, 3)
    uncached = samples.decode(config, 5)
    assert samples.decode(config, 1) is first
    assert samples.decode(config, 3) is second
    assert samples.decode(config, 5) is not uncached
    assert samples.bytes_used == 24


@pytest.mark.parametrize("color_bytes,cached_frames", [(20_000, 1), (96 * 1024**2, 5)])
def test_preview_caches_tone_maps_and_prepared_colors(
    tmp_path, monkeypatch, set_size_limits, color_bytes, cached_frames
):
    from dataclasses import replace

    from luma_fattal import core
    from luma_fattal.ui import server

    set_size_limits(40, pixels=3000)
    app = Workbench(tmp_path / "session", tmp_path / "no-presets")
    app.uploads["first"] = dict(path=tmp_path / "first.mp4", duration=10)
    app.uploads["second"] = dict(path=tmp_path / "second.mp4", duration=10)
    monkeypatch.setattr(server, "_probe", lambda *_: {})
    monkeypatch.setattr(server, "_geometry", lambda *_: ((81, 51), 0, 1))
    monkeypatch.setattr(server, "PREVIEW_COLOR_BYTES", color_bytes)

    def decode(source, config, timestamp, *, stream=None):
        seed = int(timestamp) + 100 * (source.stem == "second")
        return np.random.default_rng(seed).integers(0, 256, (51, 81, 3), np.uint8)

    original_solve = core._solve_tone_map
    original_cleanup = server.SourceCleanup.__call__
    solves = []
    cleanups = []

    def solve(*args):
        solves.append(True)
        return original_solve(*args)

    def cleanup(self, *args):
        cleanups.append(True)
        return original_cleanup(self, *args)

    def preview(config, expected_solves, upload="first"):
        before = len(solves)
        before_cleanup = len(cleanups)
        identifier = app.submit("preview", dict(upload=upload, config=config.to_dict()))
        app.executor.submit(lambda: None).result(timeout=10)
        job = app.jobs[identifier]
        assert job["state"] == "done", job
        assert len(solves) - before == expected_solves
        expected_cleanups = expected_solves
        if expected_solves == 0 and config.parameters.fade < 100:
            expected_cleanups = 5 - cached_frames
        assert len(cleanups) - before_cleanup == expected_cleanups
        source = app.uploads[upload]["path"]
        for sample in job["frames"]:
            expected = preview_frame(source, config, sample["time"])
            with Image.open(BytesIO(app.preview_bitmaps[sample["url"]])) as actual:
                np.testing.assert_array_equal(actual, expected)

    monkeypatch.setattr(server, "decoded_sample", decode)
    monkeypatch.setattr(core, "_solve_tone_map", solve)
    monkeypatch.setattr(server.SourceCleanup, "__call__", cleanup)
    config = Config()
    config = replace(config, video=replace(config.video, flat_cleanup=0.5))
    color_edit = replace(
        config,
        parameters=FilterParams(
            output_gamma=1.2, saturation=70, black_level=5, vibrance=20, fade=23
        ),
    )
    try:
        preview(config, 5)
        preview(color_edit, 0)
        preview(replace(config, parameters=FilterParams(fade=100)), 0)
        preview(color_edit, 0)
        beta_edit = replace(
            color_edit, parameters=replace(color_edit.parameters, beta=65)
        )
        preview(beta_edit, 5)
        cleanup_edit = replace(
            beta_edit, video=replace(beta_edit.video, flat_cleanup=0.75)
        )
        preview(cleanup_edit, 5)
        decode_edit = replace(
            cleanup_edit, video=replace(cleanup_edit.video, deband="gentle")
        )
        preview(decode_edit, 5)
        preview(decode_edit, 5, upload="second")
    finally:
        app.executor.shutdown()


def test_preview_uses_cpu_during_warmup_and_reuses_cuda_afterward(
    tmp_path, monkeypatch
):
    from dataclasses import replace
    from threading import Event, Thread
    from types import SimpleNamespace

    from luma_fattal.ui import server

    warming = Event()
    resume = Event()
    gpu_calls = []
    cpu_calls = []
    pixels = np.zeros((24, 32, 3), np.uint8)

    class FakeCore:
        def __init__(self):
            self.solver = SimpleNamespace(parallel_edge=True, graphs={})
            self.history = {}
            self.device_masks = {}
            self.host_rings = {}
            self.pending_history = []
            self.buffers = {}
            self.axes = {}
            self.resize_axes = {}
            self.mask_axes = {}
            self.noise_fields = {}

        def __call__(self, frame, config, treatment, *, tone_map=None):
            assert not self.solver.parallel_edge
            if frame.shape == (64, 64, 3):
                warming.set()
                assert resume.wait(10)
                return frame
            assert config.video.gpu_iterations is None
            assert config.video.lighting_scale == 1.0
            assert config.video.gpu_buffer_reuse
            assert not config.video.gpu_cleanup_graph
            assert treatment.frames == 0
            assert not self.history
            self.history[0] = True
            self.solver.graphs[config.numerics.iterations] = True
            treatment.frames = 1
            gpu_calls.append((self, config.parameters.beta))
            if config.parameters.beta == 60:
                raise server.GPUUnavailable("simulated CUDA failure")
            return np.full_like(frame, 42)

    def cpu(frame, variant, params, *_, source_cleanup, **__):
        assert source_cleanup.frames == 0
        cpu_calls.append(params.beta)
        return frame

    monkeypatch.setattr(server, "CudaCore", FakeCore)
    monkeypatch.setattr(server, "decoded_sample", lambda *_: pixels)
    monkeypatch.setattr(server, "process_pixels", cpu)
    cuda = server._PreviewCuda()
    thread = Thread(target=cuda.warm)
    thread.start()
    config = Config()
    config = replace(
        config,
        video=replace(
            config.video,
            filter_backend="auto",
            gpu_iterations=12,
            lighting_scale=0.5,
            flat_cleanup=0.75,
        ),
    )

    def sample(recipe):
        return preview_frame(tmp_path / "source.mp4", recipe, 1, cuda=cuda).getpixel(
            (0, 0)
        )

    try:
        assert warming.wait(10)
        assert sample(config) == (0, 0, 0)
    finally:
        resume.set()
        thread.join(timeout=10)
    assert not thread.is_alive()
    assert sample(config) == (42, 42, 42)
    edited = replace(
        config,
        parameters=FilterParams(beta=70),
        numerics=replace(config.numerics, iterations=60),
    )
    assert sample(edited) == (42, 42, 42)
    assert gpu_calls[0][0] is gpu_calls[1][0]
    assert list(gpu_calls[0][0].solver.graphs) == [60]
    assert sample(
        replace(config, video=replace(config.video, filter_backend="cpu"))
    ) == (0, 0, 0)
    assert sample(replace(config, parameters=FilterParams(beta=60))) == (0, 0, 0)
    assert cuda.core is None
    assert sample(config) == (0, 0, 0)
    assert [beta for _, beta in gpu_calls] == [80, 70, 60]
    assert cpu_calls == [80, 80, 60, 80]
