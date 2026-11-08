# Python API

[Overview](../README.md) · [Configuration](configuration.md) · [Video](video.md)

## Images and arrays

```python
from PIL import Image
from luma_fattal import Config, apply_filter

config = Config.load("configs/fattal-1.yaml")
with Image.open("assets/lantern-garden-original.png") as image:
    result = apply_filter(image, config=config)
```

`apply_filter` returns the same kind of object it receives: a Pillow image or a
NumPy array. Arrays must have dtype `uint8` and shape `(height, width, 3)`, with
RGB values already in the intended color space, since they carry no ICC or EXIF
metadata. Use the `fattal1` and `fattal2` convenience functions to select a variant
directly. When the configuration specifies `filter: both`, `apply_filter` requires
an explicit `variant=1` or `variant=2`.

Configurations and their sections are immutable dataclasses. Modify a loaded
preset with `dataclasses.replace`, which validates each updated section:

```python
from dataclasses import replace
from pathlib import Path

config = replace(
    config,
    parameters=replace(config.parameters, tone_strength=60),
    video=replace(config.video, flat_cleanup_mode="multiscale", flat_cleanup=0.5),
)
Path("outputs/my-preset.yaml").write_text(config.to_yaml(), encoding="utf-8")
```

Create the destination directory first if needed. `Config.from_dict` fills
omitted settings from defaults, so use `replace` for partial edits to an existing
configuration. `Config.from_sources(filename, sources)` loads a mapping of file
names to YAML, TOML, or JSON text, resolving `extends` only from that mapping.

In-memory processing does not apply file encoding settings or create run records.
The API supports opaque SDR RGB. Straight RGBA is available as an explicit
experimental extension, described in the [scope notes](method.md#scope).

## Image files

Use the file adapter to apply configured encoding and save a metadata sidecar:

```python
from luma_fattal.images import process_image

record = process_image(
    "assets/lantern-garden-original.png",
    "outputs/api.jpg",
    config_path="configs/fattal-1.yaml",
)
```

When `config` is omitted, settings are loaded from `config_path`. If both are
supplied, `config` controls processing and `config_path` identifies the underlying
file in the run record. Each call processes one filter, and the output extension
must match the configured encoding.

The record includes resolved settings, dimensions, color conversion details,
dependency versions, and input/output hashes.

## Videos and decoded frames

```python
from luma_fattal.video import process_video

record = process_video(
    "local_inputs/input.mp4",
    "outputs/api.mp4",
    config=Config.load("configs/fattal-1.yaml"),
)
```

Video settings come from `config.video`, unless overridden by an explicit
`video_config=VideoConfig(...)` argument. See the [video guide](video.md) for
accepted inputs.

To use your own decoder and encoder, pass decoded frames to `process_frames`:

```python
from luma_fattal import process_frames

for filtered in process_frames(decoded_rgb_frames, config=config):
    write_frame(filtered)
```

In this example, the caller supplies `decoded_rgb_frames` and `write_frame`.
Frames must be RGB8 arrays. The iterator processes them lazily in input order,
without temporal state. The caller is responsible for container timing, color
interpretation, audio, and encoding. Use one filter per stream.
