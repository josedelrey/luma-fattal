"""Workbench contracts with controlled media and isolated session directories."""

import json
import time

import numpy as np
import pytest
from PIL import Image
from test_video import tools as tools

from luma_fattal import Config, FilterParams
from luma_fattal.ui.server import REPOSITORY, Workbench, preview_frame, sample_times
from luma_fattal.video import _decode_command, _geometry, _probe, _resolve_color


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
                assert job["completed"] == 5
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
        assert (
            b"400"
            in request(
                "/api/import", method="POST", body=b"filter: fattal1\nfilter: fattal2"
            )[0]
        )
        assert b"400" in request("/api/import", method="POST", body=b"filter: both")[0]
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
