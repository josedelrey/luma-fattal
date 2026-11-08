"""Fetch and verify the exact sources used by the desktop FFmpeg build."""

from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "outputs/ffmpeg"


def main() -> None:
    sources = json.loads((ROOT / "configs/desktop-sources.json").read_text())
    downloads = OUTPUT / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    notices = []
    for name, source in sources.items():
        suffix = ".tar.xz" if source["url"].endswith(".xz") else ".tar.gz"
        archive = downloads / f"{name}-{source['version']}{suffix}"
        if not archive.exists():
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(source["url"], timeout=120) as response:
                        archive.write_bytes(response.read())
                    break
                except OSError:
                    if attempt == 2:
                        raise
                    time.sleep(2 ** attempt)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != source["sha256"]:
            raise RuntimeError(f"Source checksum mismatch: {archive.name}")
        destination = OUTPUT / "source" / name
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        with tarfile.open(archive) as bundle:
            bundle.extractall(destination, filter="data")
        top = next(destination.iterdir())
        for file in top.iterdir():
            shutil.move(str(file), destination / file.name)
        top.rmdir()
        notices.append(f"{name} {source['version']}\nSource: {source['url']}\nSHA-256: {source['sha256']}\n")
        for pattern in ("COPYING*", "LICENSE*", "COPYRIGHT*"):
            for file in sorted(destination.glob(pattern)):
                if file.is_file():
                    notices.append(file.read_text(errors="replace"))
        if name == "nv-codec-headers":
            header = (destination / "include/ffnvcodec/nvEncodeAPI.h").read_text()
            notices.append(header.split("*/", 1)[0] + "*/")
    provenance = OUTPUT / "provenance"
    provenance.mkdir(exist_ok=True)
    shutil.copy2(ROOT / "configs/desktop-sources.json", provenance / "sources.json")
    shutil.copy2(ROOT / "scripts/build_desktop_ffmpeg.sh", provenance / "build_desktop_ffmpeg.sh")
    (provenance / "LICENSE.txt").write_text("\n\n".join(notices))
    print("Verified FFmpeg sources and corresponding license texts")


if __name__ == "__main__":
    main()
