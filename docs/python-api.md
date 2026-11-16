# Python API

[Overview](../README.md) · [Configuration](configuration.md) · [Video](video.md)

## Images and arrays

```python
from PIL import Image

from luma_fattal import Config, apply_filter

config = Config.load("configs/normal/fattal-1.yaml")
with Image.open("assets/lantern-garden-original.png") as image:
    result = apply_filter(image, config=config)
```

`apply_filter` returns a Pillow image for Pillow input and a NumPy array for
array input. Arrays must be nonempty `uint8` with shape `(height, width, 3)`
for RGB or `(height, width, 4)` for RGBA, with pixels already in the intended
color space. Set `processing.transparency` to `"straight"` for nonopaque RGBA.
When the configuration specifies `filter: both`, pass `variant=1` or
`variant=2` to choose the single result. An explicit `params=FilterParams(...)`
replaces the effect parameters from the config. The `fattal1` and `fattal2`
convenience functions select the variant and accept individual parameter
overrides, for example `fattal2(image, config=config, tone_strength=60)`.

For Cross-Scale, load a recipe from `configs/cross-scale/` and pass it to
`apply_filter` or `process_frames`. You can also construct
`Config(mode="cross-scale", cross_scale=CrossScaleConfig(coupling="smooth", strength=70))`.
For a single image, use `cross_scale(image, strength=70, relief=40)` to apply
Engrave with reduced relief, or `cross_scale(image, coupling="smooth", strength=70)`
to soften fine detail.
`CrossScaleConfig` and `cross_scale` are both exported from `luma_fattal`.

Configurations and their sections are immutable dataclasses. Modify a loaded
preset with `dataclasses.replace`, which validates each updated section:

```python
from dataclasses import replace
from pathlib import Path

from luma_fattal import EffectStages

config = replace(
    config,
    parameters=replace(
        config.parameters,
        tone_strength=60,
        sharpen=100,
        effect_stages=(("sharpen", EffectStages(pre=True, pre_strength=50)),),
    ),
)
Path("outputs").mkdir(exist_ok=True)
Path("outputs/my-preset.yaml").write_text(config.to_yaml(), encoding="utf-8")
```

This sets Sharpen to 50 before the filter and 100 after it. Use
`Config.load(path)` for a YAML, TOML or JSON file. `Config.from_dict` accepts a
parsed recipe and fills omitted settings from defaults. `Config.from_sources`
accepts a filename and a mapping of filenames to YAML, TOML or JSON text,
resolving `extends` from that mapping. Use `to_yaml()` or `to_toml()` for
serialized recipes or `to_dict()` for JSON-compatible data.

In-memory processing does not apply file encoding settings or create run records.
The API supports opaque SDR RGB. Straight RGBA is available as an explicit
experimental extension, described in the [scope notes](method.md#scope).

## Image files

Use the file adapter to apply configured encoding and save a metadata sidecar:

```python
from luma_fattal.images import process_image

record = process_image(
    "assets/lantern-garden-original.png",
    "outputs/api-image.jpg",
    config_path="configs/normal/fattal-1.yaml",
)
```

When `config` is omitted, settings are loaded from `config_path`, if supplied.
If both are supplied, `config` controls processing and `config_path` identifies
the underlying file in the run record. Each call processes one filter, and the
output extension must match the configured encoding. Use an unused output path
with no matching `.meta.json` sidecar.

The record includes resolved settings, dimensions, color conversion details,
dependency versions, and input/output hashes.

## Videos and decoded frames

```python
from luma_fattal import Config
from luma_fattal.video import process_video


def report_progress(completed, total):
    if total is None:
        print(f"{completed} frames")
    else:
        print(f"{completed}/{total} frames")


record = process_video(
    "local_inputs/input.mp4",
    "outputs/api-video.mp4",
    config=Config.load("configs/normal/fattal-1.yaml"),
    on_progress=report_progress,
)
```

Video settings come from `config.video`. The optional `video_config` argument
replaces that whole section for the run. Use `ffmpeg` and `ffprobe` to supply
executable paths, and `progress=True` for the built-in terminal progress bar.
The function returns the run record and writes the matching `.meta.json` sidecar.
See the [video guide](video.md) for accepted inputs and output requirements.

To use your own decoder and encoder, pass decoded frames to `process_frames`:

```python
from luma_fattal import process_frames

for filtered in process_frames(decoded_rgb_frames, config=config):
    write_frame(filtered)
```

In this example, the caller supplies `decoded_rgb_frames` and `write_frame`.
Frames must be nonempty RGB8 arrays. The iterator processes them lazily in
input order and uses one filter per stream. It uses the image filter settings
and fixed size limits. Decoding, timing, color interpretation, stream encoding,
and the treatments configured in `config.video` belong to the video adapter.
Custom pipelines can supply a `source_cleanup` callback that receives working
RGB8 and reference luminance and returns floating-point RGB and luminance.
Any temporal state for that callback belongs to the caller.
