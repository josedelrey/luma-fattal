"""Collect installed dependency notices for the desktop application."""

from __future__ import annotations

import importlib.metadata
import json
import platform
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def collect(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "LICENSE", destination / "PROJECT-LICENSE.txt")
    inventory = []
    for package in sorted(importlib.metadata.distributions(), key=lambda item: item.metadata["Name"].lower()):
        name = package.metadata["Name"]
        inventory.append({"name": name, "version": package.version})
        for file in package.files or []:
            if not any(term in file.name.lower() for term in ("license", "copying", "copyright", "notice")):
                continue
            source = Path(str(package.locate_file(file)))
            if source.is_file() and ".." not in file.parts:
                target = destination / "python-packages" / name / file
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if python_license.is_file():
        shutil.copy2(python_license, destination / "PYTHON-LICENSE.txt")
    else:
        url = f"https://raw.githubusercontent.com/python/cpython/v{platform.python_version()}/LICENSE"
        with urllib.request.urlopen(url, timeout=30) as response:
            (destination / "PYTHON-LICENSE.txt").write_bytes(response.read())
    url = f"https://docs.python.org/release/{platform.python_version()}/license.html"
    with urllib.request.urlopen(url, timeout=30) as response:
        (destination / "PYTHON-INCORPORATED-SOFTWARE-LICENSES.html").write_bytes(response.read())
    (destination / "python-environment.json").write_text(json.dumps(inventory, indent=2) + "\n")


if __name__ == "__main__":
    collect(ROOT / "outputs/desktop-notices")
