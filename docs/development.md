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

[CI](../.github/workflows/ci.yml) runs Ruff lint and Pyright on Ubuntu. It runs
the Python suite and preset checker on Ubuntu and Windows with Python 3.11
and 3.12. CI installs FFmpeg and ffprobe and requires video integration tests
with `LUMA_FATTAL_REQUIRE_VIDEO_TESTS=1`. Local runs skip tests that require
unavailable tools.

Ruff and Pyright use the repository settings in `pyproject.toml`. Pyright checks
source, tests, scripts and experiments against `.venv`. SciPy stubs are included
in the development dependencies. Missing CuPy imports are allowed at the optional
GPU import sites, so type checks also work without installing the GPU extra.
Run `ruff format .` to apply formatting changes.

NVENC option validation, automatic CPU fallback, and failure cleanup are tested
without NVIDIA hardware.
The hardware integration test runs when NVENC can initialize, otherwise it is
skipped. On an NVIDIA machine, set `LUMA_FATTAL_REQUIRE_NVENC_TESTS=1` to require
that test to pass, and run `python -m pytest -q tests/test_video.py -k nvenc`.

CUDA solver and frame agreement tests skip when the optional GPU dependencies or hardware
are unavailable. Automatic selection and fallback tests use controlled clocks
and fake devices on every platform. To require the real GPU tests:

```bash
uv sync --locked --extra gpu
LUMA_FATTAL_REQUIRE_GPU_TESTS=1 uv run --extra gpu python -m pytest -q tests/test_gpu.py
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

## Image comparison tools

Use `compare` for two images with matching dimensions. It writes
`metrics.json` with RGB error, PSNR, SSIM, and exact-pixel agreement.
Supply the original at the same dimensions to also write a difference panel.

```bash
luma-fattal compare assets/lantern-garden-fattal-1.png outputs/candidate.png \
  --original assets/lantern-garden-original.png --output outputs/comparison
```

Generate deterministic PNG inputs with `probes`, then use `evaluate` to run a
recipe over those inputs and compare the results with matching reference files:

```bash
luma-fattal probes outputs/probes
luma-fattal evaluate outputs/probes local_inputs/references outputs/evaluation \
  --config configs/fattal-1.yaml --filter both --output-format png
```

Place references in `local_inputs/references/fattal_1/` and `fattal_2/`, using
the input stem with a `.png`, `.jpg`, or `.jpeg` extension. The
`evaluation.json` report lists comparisons and missing references. Use a fresh
evaluation directory because the generated image outputs cannot be overwritten.

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

The Electron shell in `desktop/` displays the workbench in a native window.
Development requires Node.js 22.12 or later, the project's Python environment,
and FFmpeg and ffprobe on `PATH`. Install the desktop dependencies:

```bash
npm --prefix desktop ci
```

On Linux systems that restrict unprivileged user namespaces, configure
Electron's sandbox helper after installing desktop dependencies:

```bash
sudo chown root:root desktop/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 desktop/node_modules/electron/dist/chrome-sandbox
```

Repeat this setup after `npm --prefix desktop ci` replaces `node_modules`.

Launch the desktop application:

```bash
npm --prefix desktop start
```

Electron starts the Python backend privately and loads the interface after the
server responds. It uses the repository's `.venv` Python when available, otherwise
`python3` on Linux/macOS or `python` on Windows. Set `LUMA_FATTAL_PYTHON` to an
executable path to select another environment. Run `uv sync --locked` first if
the Python environment has not been installed.

Desktop sessions, backend logs, and Numba cache files are stored under
Electron's application data directory. Presets and the window icon are read from
the source tree during development. A packaged build will read them from its
resources directory. The backend runs with the session directory as its working
directory, so starting Electron from another location does not redirect files.

The desktop opens with a 4:3 aspect ratio. Its initial width is about 54% of
the primary display's longer dimension, constrained by the work area. You can
resize it within the display and drag it using the title bar. The renderer
scales the 1200×900 reference layout to fill the window at 100% page zoom.
Opening **More settings** makes the workbench scroll while the title bar stays
visible and filter previews stay within reach. The completed render panel sits
below the previews in this layout. Closing the window stops the Python backend
and its child processes and interrupts active processing.

Native Open dialogs select videos and YAML, TOML, or JSON recipes. The desktop
uses native Save dialogs for videos, run records, and saved configurations.
Browser sessions use file inputs and downloads. Run `npm --prefix desktop test`
for desktop URL, file handling, and window sizing checks.

The frontend lives in `src/luma_fattal/ui/`. Edit `index.html`, `style.css`,
`app.js`, and `settings.js` there. Refresh the browser after frontend edits,
and restart the server after Python edits. The desktop development shell
launches that same server privately. In this directory, `server.py` handles
local input copies, configuration validation, previews, render jobs, and
byte-range media serving. Export uses `process_video(on_progress=...)`.
Run `python -m pytest -q tests/test_ui.py tests/test_video.py` for focused checks.

Workbench textures, logos, and fonts are in `src/luma_fattal/ui/assets/`.
The placement and color treatment of `viscera.png`, `panel-078-red.png`, and
`logo-purple.png` are defined in `style.css`. The workbench serves these
assets and all frontend code locally.

## Desktop builds and releases

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
uv run --locked --extra gpu python scripts/prepare_desktop_release.py \
  --resources outputs/desktop-release-metadata --platform linux --arch x64
npm --prefix desktop run package:dir -- --linux
uv run --locked --extra gpu python scripts/smoke_desktop_backend.py outputs/desktop-app/linux-unpacked/resources
```

The unpacked Linux app is in `outputs/desktop-app/linux-unpacked/`. On Linux
systems that restrict unprivileged user namespaces, configure the Chromium
sandbox helper before launching:

```bash
sudo chown root:root outputs/desktop-app/linux-unpacked/chrome-sandbox
sudo chmod 4755 outputs/desktop-app/linux-unpacked/chrome-sandbox
./outputs/desktop-app/linux-unpacked/luma-fattal-desktop
```

Reapply those permissions after rebuilding the app. For a temporary local test,
`./outputs/desktop-app/linux-unpacked/luma-fattal-desktop --no-sandbox` also
starts the app with Chromium's process sandbox disabled.
The smoke script generates a short video and checks bundled presets, textures,
preview frames, processing, export, FFprobe output, and Numba caching from a
temporary working directory. The desktop workflow builds Windows x64, Linux x64
and macOS arm64 on native GitHub runners and checks both the backend and window.
It then creates Windows ZIP, Linux DEB and tar.gz, and macOS DMG downloads with
version metadata. The DEB is the recommended Linux download. Electron Builder's
standard installer configures the sandbox helper and installs a scoped AppArmor
profile on supported Ubuntu versions. It also creates an application-menu entry.
CI installs the DEB on Ubuntu 22.04 and 24.04, launches it as a normal user with
sandboxing enabled, then uninstalls it. Publication waits for these checks.
macOS requires version 14 or newer. The Linux baseline is Ubuntu 22.04
with desktop GTK/NSS libraries. Intel Mac and Linux ARM builds are not included.

Windows builds are unsigned, and macOS builds use ad-hoc signatures without
notarization.
Release assets include exact FFmpeg and dependency source archives, their build
recipe and SHA-256 checksums. Only small source manifests and scripts are tracked
in Git. Environments, downloaded sources and generated packages stay ignored.

To publish, run the Desktop packages workflow with its `publish` input enabled.
The publication job waits for CI and every platform to pass on the release
commit, creates a draft release, uploads the packages, corresponding sources
and checksums, then publishes it. Pushing a tag matching the version in
`desktop/package.json` with the `v` prefix also triggers publication. A version
with a prerelease suffix is published as a prerelease. The workflow uses the
[desktop release notes](../.github/desktop-release-notes.md).
