"""Convenience functions for the gradient-domain filters."""

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


@overload
def cross_scale(
    image: Image.Image,
    *,
    config: Config | None = None,
    coupling: str | None = None,
    strength: float | None = None,
    relief: float | None = None,
    relief_width: float | None = None,
    eq_gains: tuple[float, ...] | None = None,
    **parameters: float,
) -> Image.Image: ...


@overload
def cross_scale(
    image: np.ndarray,
    *,
    config: Config | None = None,
    coupling: str | None = None,
    strength: float | None = None,
    relief: float | None = None,
    relief_width: float | None = None,
    eq_gains: tuple[float, ...] | None = None,
    **parameters: float,
) -> np.ndarray: ...


def cross_scale(
    image: Image.Image | np.ndarray,
    *,
    config: Config | None = None,
    coupling: str | None = None,
    strength: float | None = None,
    relief: float | None = None,
    relief_width: float | None = None,
    eq_gains: tuple[float, ...] | None = None,
    **parameters: float,
) -> Image.Image | np.ndarray:
    """Apply Cross-Scale with Fattal 1 and optional coupling overrides."""
    resolved = resolve_config(config)
    settings = resolved.cross_scale
    resolved = replace(
        resolved,
        mode="cross-scale",
        filter="fattal1",
        cross_scale=replace(
            settings,
            coupling=settings.coupling if coupling is None else coupling,
            strength=settings.strength if strength is None else strength,
            relief=settings.relief if relief is None else relief,
            relief_width=settings.relief_width if relief_width is None else relief_width,
            eq_gains=settings.eq_gains if eq_gains is None else eq_gains,
        ),
    )
    return apply_filter(
        image, params=replace(resolved.parameters, **parameters), config=resolved
    )
