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

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "src/luma_fatal/ui"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, default=shutil.which("ffmpeg"))
    parser.add_argument("--ffprobe", type=Path, default=shutil.which("ffprobe"))
    parser.add_argument("--ffmpeg-license", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/desktop-backend")
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
    separator = os.pathsep
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir",
        "--name", "luma-fattal-backend", "--distpath", str(output),
        "--workpath", str(output / "work"), "--specpath", str(output),
        "--paths", str(ROOT / "src"),
        "--additional-hooks-dir", str(ROOT / "scripts/pyinstaller_hooks"),
        "--collect-all", "numba", "--collect-all", "llvmlite",
    ]
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    for package in (project["project"]["name"], "numpy", "scipy", "Pillow", "numba", "llvmlite", "PyYAML", "tqdm"):
        command += ["--copy-metadata", package]
    for file in ("index.html", "style.css", "app.js"):
        command += ["--add-data", f"{UI / file}{separator}luma_fatal/ui"]
    for file in (UI / "assets").glob("*.png"):
        command += ["--add-data", f"{file}{separator}luma_fatal/ui/assets"]
    command += ["--add-data", f"{ROOT / 'LICENSE'}{separator}licenses"]
    command += ["--add-data", f"{license_file}{separator}licenses/ffmpeg"]
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
        if not list(Path(cache).rglob("*.nbc")):
            raise RuntimeError("The frozen Numba function did not create a cache file")
    for tool in ("ffmpeg", "ffprobe"):
        filename = bundled_tools / (f"{tool}.exe" if os.name == "nt" else tool)
        subprocess.run([str(filename), "-version"], capture_output=True, check=True, timeout=20)
    print(bundle)


if __name__ == "__main__":
    main()
