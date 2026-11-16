"""Configurable gradient-domain image processing."""

from .configuration import (
    Config,
    CrossScaleConfig,
    EffectStages,
    FilterParams,
    ImageConfig,
    NumericsConfig,
    OutputConfig,
    ProcessingConfig,
    VideoConfig,
)
from .filters import cross_scale, fattal1, fattal2
from .pipeline import apply_filter, process_frames

__all__ = [
    "Config",
    "CrossScaleConfig",
    "EffectStages",
    "FilterParams",
    "ImageConfig",
    "NumericsConfig",
    "OutputConfig",
    "ProcessingConfig",
    "VideoConfig",
    "apply_filter",
    "cross_scale",
    "fattal1",
    "fattal2",
    "process_frames",
]
__version__ = "0.1.0"
