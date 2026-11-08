Desktop release of Luma Fattal. Python, Electron, FFmpeg, ffprobe,
presets and processing dependencies are included. Python and Node.js do not
need to be installed to run these downloads.

| Download | Platform |
| --- | --- |
| `*-win-x64.zip` | Windows 10/11 x64. Extract the entire ZIP and launch Luma Fattal.exe. |
| `*-linux-amd64.deb` | Recommended for Ubuntu 22.04 or newer and compatible Debian-based systems. Install with the package manager, then launch Luma Fattal from the application menu. |
| `*-linux-x64.tar.gz` | Linux x64, Ubuntu 22.04 or newer baseline with desktop GTK/NSS libraries. Extract the entire archive and launch luma-fattal-desktop. |
| `*-mac-arm64.dmg` | Apple Silicon Macs, macOS 14 or newer. Copy the app to Applications. Intel Macs are not included. |
| `*-ffmpeg-sources.tar.gz` | Exact unmodified FFmpeg, x264, zimg, zlib and NVENC header sources with checksums and the build recipe. |
| `SHA256SUMS.txt` | SHA-256 checksums for every release download. |

These builds are unsigned. The macOS app has only an ad-hoc signature and
has not been notarized. Windows SmartScreen and macOS Gatekeeper may block or
warn about these downloads. They are not represented as trusted signed builds.

Linux and Windows include optional NVIDIA CUDA processing and NVENC encoding.
A compatible NVIDIA GPU and driver are required for acceleration. CPU fallback
is available. macOS uses CPU processing. Hardware acceleration was not tested on
the GitHub-hosted build runners.

The Linux `.deb` installer configures Chromium's sandbox and installs an
application-menu entry. From the directory containing the download, install it with:

```bash
sudo apt install ./Luma-Fattal-*-linux-amd64.deb
```

Launch Luma Fattal from the application menu or run `luma-fattal-desktop`.
The package handles sandbox configuration again on upgrades.

The portable `.tar.gz` archive does not have an installation step. On Linux
systems that restrict unprivileged user namespaces, set up its extracted
Chromium helper once, from the application's directory:

```bash
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
```

Run the application as your normal user. The `--no-sandbox` flag is intended only
for controlled testing and disables Chromium's process sandbox.

Closing the window interrupts active processing and stops the private Python
backend. Sessions, caches and logs are kept in the OS application-data directory.
Exported videos are silent H.264 MP4.

Each platform build checks the frozen backend, Numba caching, video previews,
processing, export, UI assets and packaged H.264 playback before publication.
Checksums verify download integrity and do not replace publisher signatures.

Project code is MIT with the BSD notices in LICENSE. Bundled dependencies retain
their own licenses. FFmpeg includes libx264 and is distributed under GPL-2.0-or-later.
The corresponding FFmpeg sources and build recipe are attached to this release.
Full Python dependency notices are included under the backend's `_internal/licenses/`
directory. Electron and Chromium notices are also included in the application.
