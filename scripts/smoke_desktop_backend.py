"""Exercise a frozen backend with bundled tools and writable temporary state."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="Electron resources directory")
    parser.add_argument("--save-video", type=Path, help="Keep the processed smoke video for window playback checks")
    parser.add_argument("--check-gpu", action="store_true", help="Require CUDA filtering on an NVIDIA GPU")
    args = parser.parse_args()
    resources = args.bundle.resolve()
    backend = resources / "backend/luma-fattal-backend"
    executable = backend / ("luma-fattal-backend.exe" if os.name == "nt" else "luma-fattal-backend")
    tools = backend / "_internal/tools"
    ffmpeg = tools / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    ffprobe = tools / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        env = os.environ.copy()
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        env["PATH"] = f"{tools}{os.pathsep}{env.get('PATH', '')}"
        env["NUMBA_CACHE_DIR"] = str(root / "cache")
        source = root / "source.mp4"
        subprocess.run([
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc2=size=960x540:rate=8:duration=4" if args.check_gpu else
            "testsrc2=size=64x48:rate=5:duration=1", "-an", "-c:v",
            "libx264", "-pix_fmt", "yuv420p", "-y", str(source),
        ], env=env, check=True, timeout=30)
        process = subprocess.Popen([
            str(executable), "--no-browser", "--presets", str(resources / "configs"),
            "--output-dir", str(root / "sessions"),
        ], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=os.name != "nt")
        try:
            assert process.stdout is not None and process.stderr is not None
            first = process.stdout.readline().strip()
            if not first.startswith("Luma Fattal: "):
                raise RuntimeError(f"Backend did not start: {first} {process.stderr.read()}")
            base = first.removeprefix("Luma Fattal: ")
            parsed = urllib.parse.urlsplit(base)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            token = parsed.query

            def request(route: str, body: bytes | None = None) -> bytes:
                url = f"{origin}{route}{'&' if '?' in route else '?'}{token}"
                call = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET")
                with urllib.request.urlopen(call, timeout=120) as response:
                    return response.read()

            def request_json(route: str, body: bytes | None = None) -> dict:
                return json.loads(request(route, body))

            presets = request_json("/api/presets")
            assert "fattal-1-fast" in presets
            assert request("/assets/logo-purple.png").startswith(b"\x89PNG")
            assert request("/assets/viscera.png").startswith(b"\x89PNG")
            assert b".application-title" in request("/style.css")
            assert b"fileDialogs" in request("/app.js")
            uploaded = request_json("/api/upload", source.read_bytes())
            expected_size = (960, 540) if args.check_gpu else (64, 48)
            assert (uploaded["width"], uploaded["height"]) == expected_size
            config = presets["fattal-1-fast"]
            config["video"]["encoder"] = "libx264"
            for kind in (("process",) if args.check_gpu else ("preview", "process")):
                job = request_json(f"/api/{kind}", json.dumps({"upload": uploaded["upload"], "config": config}).encode())["job"]
                deadline = time.monotonic() + 180
                while True:
                    state = request_json(f"/api/jobs/{job}")
                    if state["state"] == "error":
                        raise RuntimeError(state["error"])
                    if state["state"] == "done":
                        break
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"{kind} did not finish")
                    time.sleep(0.25)
                if kind == "preview":
                    assert len(state["frames"]) == 5
                    assert request(state["frames"][0]["url"]).startswith(b"\x89PNG")
                else:
                    video = root / "processed.mp4"
                    video.write_bytes(request(state["url"]))
                    metadata = request(state["metadata"])
                    assert json.loads(metadata)["encoding"]["encoder"] == "libx264"
                    if args.check_gpu:
                        filtering = json.loads(metadata)["filtering"]
                        print(f"Frozen filtering: {filtering}")
                        assert filtering["backend"] == "cuda" and filtering["cuda_frames"] > 0
                    result = subprocess.run([str(ffprobe), "-v", "error", "-show_entries",
                        "stream=width,height", "-of", "json", str(video)],
                        capture_output=True, text=True, env=env, check=True, timeout=30)
                    assert json.loads(result.stdout)["streams"][0]["width"] > 0
                    if args.save_video:
                        args.save_video.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(video, args.save_video)
            assert list((root / "cache").rglob("*.nbc"))
            print("Frozen preview, processing, export and cache smoke passed")
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    process.terminate()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)


if __name__ == "__main__":
    main()
