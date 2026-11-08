"""Build the Python UI backend as a PyInstaller one-folder application."""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

from collect_desktop_notices import collect

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "src/luma_fattal/ui"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, default=shutil.which("ffmpeg"))
    parser.add_argument("--ffprobe", type=Path, default=shutil.which("ffprobe"))
    parser.add_argument("--ffmpeg-license", type=Path, required=True)
    parser.add_argument("--ffmpeg-provenance", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/desktop-backend")
    parser.add_argument("--gpu", action="store_true", help="Bundle optional CUDA filtering dependencies")
    args = parser.parse_args()
    if importlib.util.find_spec("PyInstaller") is None:
        parser.error("Install PyInstaller 6.22.3 into the project environment first")
    for name in ("ffmpeg", "ffprobe", "ffmpeg_license"):
        file = getattr(args, name)
        if file is None or not file.is_file():
            parser.error(f"{name.replace('_', '-')} must be an existing file")
    ffmpeg = args.ffmpeg.resolve()
    ffprobe = args.ffprobe.resolve()
    license_file = args.ffmpeg_license.resolve()
    for feature in ("libx264", "zscale"):
        result = subprocess.run(
            [str(ffmpeg), "-hide_banner", "-filters" if feature == "zscale" else "-encoders"],
            capture_output=True, text=True, check=True,
        )
        if feature not in result.stdout:
            parser.error(f"FFmpeg must support {feature}")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    notices = output / "notices"
    collect(notices)
    separator = os.pathsep
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir",
        "--name", "luma-fattal-backend", "--distpath", str(output),
        "--workpath", str(output / "work"), "--specpath", str(output),
        "--paths", str(ROOT / "src"),
        "--additional-hooks-dir", str(ROOT / "scripts/pyinstaller_hooks"),
        "--collect-all", "numba", "--collect-all", "llvmlite",
    ]
    if args.gpu:
        for module in ("cupy", "cupyx", "cupy_backends", "cuda.pathfinder",
                       "nvidia.cuda_runtime", "nvidia.cuda_nvrtc"):
            if importlib.util.find_spec(module) is None:
                parser.error(f"The CUDA extra is missing {module}. Run uv sync --locked --extra gpu")
            command += ["--collect-all", module]
        for module in ("cupyx.scipy.ndimage", "graphlib"):
            command += ["--hidden-import", module]
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    for package in (project["project"]["name"], "numpy", "scipy", "Pillow", "numba", "llvmlite", "PyYAML", "tqdm"):
        command += ["--copy-metadata", package]
    if args.gpu:
        for package in ("cupy-cuda12x", "nvidia-cuda-runtime-cu12", "nvidia-cuda-nvrtc-cu12", "cuda-pathfinder"):
            command += ["--copy-metadata", package]
    for file in ("index.html", "style.css", "app.js"):
        command += ["--add-data", f"{UI / file}{separator}luma_fattal/ui"]
    for file in (UI / "assets").glob("*.png"):
        command += ["--add-data", f"{file}{separator}luma_fattal/ui/assets"]
    command += ["--add-data", f"{ROOT / 'LICENSE'}{separator}licenses"]
    command += ["--add-data", f"{license_file}{separator}licenses/ffmpeg"]
    command += ["--add-data", f"{notices}{separator}licenses/python"]
    if args.ffmpeg_provenance:
        command += ["--add-data", f"{args.ffmpeg_provenance.resolve()}{separator}licenses/ffmpeg-build"]
    for executable in (ffmpeg, ffprobe):
        command += ["--add-binary", f"{executable}{separator}tools"]
    command.append(str(ROOT / "scripts/backend_entry.py"))
    subprocess.run(command, cwd=ROOT, check=True)
    bundle = output / "luma-fattal-backend"
    binary = bundle / ("luma-fattal-backend.exe" if os.name == "nt" else "luma-fattal-backend")
    bundled_tools = bundle / "_internal/tools"
    with tempfile.TemporaryDirectory() as cache:
        env = {**os.environ, "NUMBA_CACHE_DIR": cache,
               "PATH": f"{bundled_tools}{os.pathsep}{os.environ.get('PATH', '')}"}
        subprocess.run([str(binary), "--self-test"], env=env, check=True, timeout=120)
        if args.gpu:
            subprocess.run([str(binary), "--gpu-import-test"], env=env, check=True, timeout=30)
        if not list(Path(cache).rglob("*.nbc")):
            raise RuntimeError("The frozen Numba function did not create a cache file")
    for tool in ("ffmpeg", "ffprobe"):
        filename = bundled_tools / (f"{tool}.exe" if os.name == "nt" else tool)
        subprocess.run([str(filename), "-version"], capture_output=True, check=True, timeout=20)
    print(bundle)


if __name__ == "__main__":
    main()
