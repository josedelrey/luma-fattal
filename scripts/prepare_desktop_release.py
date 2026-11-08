"""Add release metadata and create the corresponding FFmpeg source archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def checksums(directory: Path) -> None:
    lines = []
    for file in sorted(directory.iterdir()):
        if file.is_file() and file.name != "SHA256SUMS.txt":
            with file.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            lines.append(f"{digest}  {file.name}\n")
    (directory / "SHA256SUMS.txt").write_text("".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path)
    parser.add_argument("--platform", choices=["linux", "windows", "macos"])
    parser.add_argument("--arch", choices=["x64", "arm64"])
    parser.add_argument("--checksums", type=Path)
    args = parser.parse_args()
    if args.checksums:
        checksums(args.checksums)
        return
    if not args.resources or not args.platform or not args.arch:
        parser.error("--resources, --platform and --arch are required")
    version = json.loads((ROOT / "desktop/package.json").read_text())["version"]
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    resources = args.resources.resolve()
    resources.mkdir(parents=True, exist_ok=True)
    metadata = {"version": version, "revision": revision, "platform": args.platform,
                "architecture": args.arch, "developer_signed": False, "notarized": False,
                "cuda_included": args.platform != "macos"}
    (resources / "VERSION.json").write_text(json.dumps(metadata, indent=2) + "\n")
    shutil.copy2(ROOT / "LICENSE", resources / "LICENSE.txt")
    notice = (
        f"Luma Fattal {version} ({args.platform}, {args.arch})\n\n"
        "This build is unsigned. macOS uses ad-hoc signatures only and is not notarized.\n"
        "Python, Electron, FFmpeg, ffprobe and processing dependencies are included.\n"
        "NVIDIA acceleration requires a compatible GPU and installed driver. CPU fallback is available.\n"
        "Launch after installing the Linux .deb, extracting the archive or copying the macOS app from the DMG.\n"
        "Sessions, logs and caches are stored in your operating system's application-data directory.\n"
        "Closing the application interrupts active processing.\n\n"
        "Linux: supported baseline is Ubuntu 22.04 x64 with desktop GTK/NSS libraries.\n"
        "Recommended: install the .deb with sudo apt install ./Luma-Fattal-*-linux-amd64.deb.\n"
        "Then launch Luma Fattal from the application menu or run luma-fattal-desktop.\n"
        "The installer configures Chromium's sandbox automatically, including on upgrades.\n"
        "For portable archives where user namespaces are restricted, configure the helper once:\n"
        "  sudo chown root:root chrome-sandbox\n"
        "  sudo chmod 4755 chrome-sandbox\n"
        "Do not run the application itself as root.\n\n"
        "Licenses are in backend/luma-fattal-backend/_internal/licenses and Electron's license files.\n"
        "FFmpeg is distributed under GPL-2.0-or-later with libx264. Its exact sources and build\n"
        "recipe are available in the ffmpeg-sources archive attached to this GitHub release:\n"
        f"https://github.com/josedelrey/luma-fattal/releases/tag/v{version}\n"
    )
    (resources / "README-DESKTOP.txt").write_text(notice)
    if args.platform == "linux":
        output = ROOT / "outputs/desktop-release"
        output.mkdir(exist_ok=True)
        with tarfile.open(output / f"Luma-Fattal-{version}-ffmpeg-sources.tar.gz", "w:gz") as bundle:
            for file in sorted((ROOT / "outputs/ffmpeg/downloads").iterdir()):
                bundle.add(file, arcname=f"downloads/{file.name}")
            for file in [ROOT / "configs/desktop-sources.json", ROOT / "scripts/build_desktop_ffmpeg.sh",
                         ROOT / "scripts/prepare_desktop_ffmpeg.py"]:
                bundle.add(file, arcname=str(file.relative_to(ROOT)))
            data = ROOT / "outputs/ffmpeg/provenance/SOURCE-README.txt"
            data.write_text("The included archives are unmodified upstream sources. No patches were applied.\n"
                            "Use Python 3.11+ to run scripts/prepare_desktop_ffmpeg.py, then run\n"
                            "bash scripts/build_desktop_ffmpeg.sh on the target platform.\n"
                            "Build prerequisites and exact runner setup are in the tagged repository's\n"
                            ".github/workflows/desktop.yml. Source URLs and SHA-256 hashes are pinned\n"
                            "in configs/desktop-sources.json. Copy downloads/ into outputs/ffmpeg/downloads/\n"
                            "to build entirely from the supplied source archives.\n")
            bundle.add(data, arcname="README.txt")


if __name__ == "__main__":
    main()
