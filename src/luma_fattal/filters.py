"""Convenience functions for the two Fattal variants."""

from __future__ import annotations

from dataclasses import replace
from typing import overload

import numpy as np
from PIL import Image

from .configuration import Config, resolve_config
from .pipeline import apply_filter


@overload
def fattal1(
    image: Image.Image,
    *,
    profile: str | None = None,
    config: Config | None = None,
    **parameters: float,
) -> Image.Image: ...


@overload
def fattal1(
    image: np.ndarray,
    *,
    profile: str | None = None,
    config: Config | None = None,
    **parameters: float,
) -> np.ndarray: ...


def fattal1(
    image: Image.Image | np.ndarray,
    *,
    profile: str | None = None,
    config: Config | None = None,
    **parameters: float,
) -> Image.Image | np.ndarray:
    """Apply Fattal 1 with effect controls and optional output gamma."""
    resolved = resolve_config(config, profile)
    return apply_filter(
        image, 1, replace(resolved.parameters, **parameters), config=resolved
    )


@overload
def fattal2(
    image: Image.Image,
    *,
    profile: str | None = None,
    config: Config | None = None,
    **parameters: float,
) -> Image.Image: ...


@overload
def fattal2(
    image: np.ndarray,
    *,
    profile: str | None = None,
    config: Config | None = None,
    **parameters: float,
) -> np.ndarray: ...


def fattal2(
    image: Image.Image | np.ndarray,
    *,
    profile: str | None = None,
    config: Config | None = None,
    **parameters: float,
) -> Image.Image | np.ndarray:
    """Apply Fattal 2 with effect controls and optional output gamma."""
    resolved = resolve_config(config, profile)
    return apply_filter(
        image, 2, replace(resolved.parameters, **parameters), config=resolved
    )
