# Development and verification

[Overview](../README.md) · [Method](method.md) · [Experiments](experiments.md)

## Checks

Run the development checks:

```bash
uv sync --locked --python 3.11
source .venv/bin/activate
ruff format --check .
ruff check .
pyright
python -m pytest -q
python scripts/check_presets.py
```

[CI](../.github/workflows/ci.yml) runs the test suite and preset checks on Ubuntu
and Windows with Python 3.11 and 3.12. FFmpeg and ffprobe are installed
there, and video integration tests must pass. In local runs, those tests are
skipped if the tools are unavailable.

Ruff and Pyright use the repository settings in `pyproject.toml`. Pyright checks
source, tests, scripts and experiments against `.venv`. SciPy stubs are included
in the development dependencies. Missing CuPy imports are allowed at the optional
GPU import sites, so type checks also work without installing the GPU extra.
Run `ruff format .` to apply formatting changes.

NVENC option validation, automatic CPU fallback, and failure cleanup are tested
without NVIDIA hardware.
The hardware integration test runs when NVENC can initialize, otherwise it is
skipped. On an NVIDIA machine, set `LUMA_FATAL_REQUIRE_NVENC_TESTS=1` to require
that test to pass, and run `python -m pytest -q tests/test_video.py -k nvenc`.

CUDA solver and frame agreement tests skip when the optional GPU dependencies or hardware
are unavailable. Automatic selection and fallback tests use controlled clocks
and fake devices on every platform. To require the real GPU tests:

```bash
uv sync --locked --extra gpu
LUMA_FATAL_REQUIRE_GPU_TESTS=1 uv run --extra gpu python -m pytest -q tests/test_gpu.py
```

Set the environment variable with your shell's syntax on Windows. GPU tests
cover odd/even geometry, reference boundary behavior, both filter variants,
resizing, source cleanup, effect controls, noise, and denoising against the CPU
reference. CUDA graphs and kernels initialize on the first eligible frame.
Controlled failures verify cleanup history restoration on fallback.

Regression tests use bundled [fixtures](../tests/fixtures/) or deterministically
generated inputs. They cover scalar float32 bit patterns, filter outputs,
interpolation, geometry, decoding, and color conversion. Video tests use generated
clips and synthetic audio to check frame counts, timing, geometry, and color tags,
as well as agreement with the image API before lossy encoding.

## Frozen presets

The preset checker compares dimensions, RGB pixels, encoded JPEG bytes, decoded
pixels, and codec settings against [presets.json](../tests/fixtures/presets.json).
It explicitly uses shadow softness `0` to preserve the frozen image baselines.
Bundled YAML presets default to `6`.
The checker never regenerates expected results. To retain outputs and a JSON
report, run:

```bash
python scripts/check_presets.py --output outputs/preset-check
```

Use a new output directory for each run. Frozen results detect numerical and
encoding changes in the bundled preset cases.

## README images

Regenerate the opening comparison from its bundled input:

```bash
luma-fattal apply assets/lantern-garden-original.png outputs/readme-comparison-new \
  --config configs/fattal-1.yaml --filter both --shadow-softness 6 --output-format png
```

This command applies both reference variants with shadow softness 6 and saves
`fattal1.png`, `fattal2.png`, and their `.meta.json` run records. The source and
published results are 880×1100 PNGs.

Regenerate the image in the CLI example:

```bash
luma-fattal apply assets/tea-by-the-water-original.png outputs/readme-tea-new.png \
  --config configs/fattal-1.yaml --filter fattal1 --shadow-softness 6 --output-format png
```

Its source and filtered result are 1080×810 PNGs.

README image sources and filtered results are kept in `assets/`. Use the ignored
`local_inputs/` directory for experimental inputs and `outputs/` for generated artifacts.


## Workbench appearance

The Electron shell in `desktop/` displays the same UI in a fixed-size desktop
window. Development requires Node.js 22.12 or later and the existing Python
environment with FFmpeg and ffprobe. Install the desktop dependencies once:

```bash
npm --prefix desktop ci
```

Launch the desktop application:

```bash
npm --prefix desktop start
```

Electron starts the Python backend privately and loads the interface after the
server responds. It uses the repository's `.venv` Python when available, otherwise
`python3` on Linux/macOS or `python` on Windows. Set `LUMA_FATAL_PYTHON` to an
executable path to select another environment. Run `uv sync --locked` first if
the Python environment has not been installed.

Desktop sessions, backend logs, and Numba cache files are stored under
Electron's application data directory. Presets and the window icon are read from
the source tree during development. A packaged build will read them from its
resources directory. The backend runs with the session directory as its working
directory, so starting Electron from another location does not redirect files.

The frameless window uses the interface's blue title bar as its draggable frame,
with working minimize and close buttons. The bar spans the top edge and stays
visible while expanded settings scroll beneath it. It opens at up to 1200 by
900 pixels, constrained by the display work area. Resizing, maximizing, and
fullscreen are disabled. Electron requests square outer corners.
At its default size, the textured workbench fills the window and the preview,
signal, and export panels fit without a page scrollbar. Video and Configuration
share one row, with Filter preview and Clip / Signal aligned below them.
Opening More settings adds a classic gray scrollbar so the extra controls
remain reachable. The completed render panel appears beneath Filter preview
when More settings is open.
Closing the window exits Electron and stops its Python backend and child
processes. Active processing is interrupted when the application exits.

Desktop releases use pinned FFmpeg sources with libx264, zscale and zlib.
Linux and Windows also include NVENC headers and the Python CUDA extra.
The source URLs and SHA-256 hashes are in `configs/desktop-sources.json`.
With a C/C++ toolchain, Make, Autotools, NASM and pkg-config installed, prepare
the tools and build the backend:

```bash
uv sync --locked --extra gpu
uv run --locked --extra gpu python scripts/prepare_desktop_ffmpeg.py
bash scripts/build_desktop_ffmpeg.sh
uv run --locked --extra gpu python scripts/build_desktop_backend.py \
  --ffmpeg outputs/ffmpeg/prefix/bin/ffmpeg \
  --ffprobe outputs/ffmpeg/prefix/bin/ffprobe \
  --ffmpeg-license outputs/ffmpeg/provenance/LICENSE.txt \
  --ffmpeg-provenance outputs/ffmpeg/provenance --gpu
```

The builder checks for FFmpeg with libx264 and zscale, then includes ffmpeg,
ffprobe, UI assets, Python package metadata, CUDA dependencies when requested,
and the exact FFmpeg build notices. Python dependency licenses are collected
from the installed environment. On macOS, omit `--extra gpu` and `--gpu`.
On Windows, the FFmpeg build uses MSYS2 and the tool filenames end in `.exe`.
Output is in ignored `outputs/desktop-backend/`. Run the frozen executable with
`--self-test` and `NUMBA_CACHE_DIR` set to a writable directory to check Numba
compilation. On a machine with an NVIDIA GPU, `--gpu-self-test` checks the
frozen CUDA path. Assemble the app after rebuilding the backend whenever the UI
changes:

```bash
npm --prefix desktop ci
npm --prefix desktop run package:dir -- --linux
uv run --locked --extra gpu python scripts/smoke_desktop_backend.py outputs/desktop-app/linux-unpacked/resources
```

The assembled Linux prototype is in ignored `outputs/desktop-app/linux-unpacked/`.
On Linux, the unpacked prototype's Chromium sandbox helper needs root ownership
and mode 4755 before launching the executable without flags:

```bash
sudo chown root:root outputs/desktop-app/linux-unpacked/chrome-sandbox
sudo chmod 4755 outputs/desktop-app/linux-unpacked/chrome-sandbox
./outputs/desktop-app/linux-unpacked/luma-fattal-desktop
```

Reapply those permissions after rebuilding the app. For a temporary local test,
`./outputs/desktop-app/linux-unpacked/luma-fattal-desktop --no-sandbox` also
starts the prototype, with Chromium's process sandbox disabled.
The smoke script generates a short video and checks bundled presets, textures,
preview frames, processing, export, FFprobe output, and Numba caching from a
temporary working directory. The desktop workflow builds Windows x64, Linux x64
and macOS arm64 on native GitHub runners and checks both the backend and window.
It then creates Windows ZIP, Linux tar.gz and macOS DMG downloads with version
metadata. macOS requires version 14 or newer. The Linux baseline is Ubuntu 22.04
with desktop GTK/NSS libraries. Intel Mac and Linux ARM builds are not included.

The first desktop version is `0.1.0-beta.1`. These prerelease builds have no
trusted publisher signature. macOS uses ad-hoc signatures and is not notarized.
Production signing requires separately configured signing credentials.
Release assets include exact FFmpeg and dependency source archives, their build
recipe and SHA-256 checksums. Only small source manifests and scripts are tracked
in Git. Environments, downloaded sources and generated packages stay ignored.

To publish, run the Desktop packages workflow with its `publish` input enabled.
The publication job waits for every platform to pass, creates a draft prerelease,
uploads the packages, corresponding sources and checksums, then publishes it.
A matching `v<desktop version>` tag also enables publication. The workflow never
uploads failed builds to a public release. Release notes are maintained in
`.github/desktop-release-notes.md`.
The desktop window uses native Open dialogs for videos and YAML or JSON recipes.
Save video, Run record, and Save config use native Save dialogs. The browser UI
continues to use its file inputs and downloads. Run `npm --prefix desktop test`
for the desktop URL and sizing checks.

The local UI lives in `src/luma_fatal/ui/`. Edit `index.html`, `style.css`, and
`app.js` directly. The server reads these files on each request, so refresh the
browser after frontend edits. Restart it after Python changes.

Replace `assets/viscera.png` for the outer frame, or `assets/panel-078-red.png`
for the video, configuration, and preview panels. The header logo is
`assets/logo-purple.png`, with its red color shift applied in CSS.
The texture variables and panel rules in `style.css` control their placement.
The bundled abstract red, black, and bone texture was generated with the built-in
image generator. Its brief was dense organic cavities with pale rims, scraped
membranes, extreme scanned contrast, and early web photomanipulation artifacts.
No external font, image, analytics, or JavaScript requests are required at runtime.

`server.py` owns local uploads, preset validation, independent preview jobs,
render jobs, and byte-range media serving. It uses the existing video pipeline
for export and exposes frame progress through `process_video(on_progress=...)`.
Run `python -m pytest -q tests/test_ui.py tests/test_video.py` for focused checks.
