"""Working-resolution effects applied to recombined RGB8 before Fade."""

from functools import lru_cache

import numpy as np
from numba import njit

from .configuration import FilterParams


def finishing_active(params: FilterParams) -> bool:
    return bool(
        params.halation
        or params.posterize
        or params.local_contrast
        or params.chroma_bleed
        or params.split_tone
    )


def guide_cell(height: int, width: int) -> int:
    return max(2, (min(height, width) + 63) // 64)


def bleed_radius(width: int, amount: float) -> int:
    return max(2, (width + 47) // 48) if amount else 0


@lru_cache(maxsize=256)
def _posterize_lut(levels: int) -> np.ndarray:
    values = np.arange(256, dtype=np.int32)
    intervals = levels - 1
    bands = (values * intervals + 127) // 255
    return ((bands * 255 + intervals // 2) // intervals).astype(np.uint8)


def posterize_lut(amount: float) -> np.ndarray:
    return _posterize_lut(round(256 * 4 ** (-3 * amount / 100)))


@njit(cache=True, inline="always")
def _luma(red, green, blue):
    return np.int32((4899 * red + 9617 * green + 1868 * blue + 8192) >> 14)


@njit(cache=True, nogil=True)
def _make_guide(rgb, cell):
    height, width = rgb.shape[:2]
    gh, gw = (height + cell - 1) // cell, (width + cell - 1) // cell
    guide = np.empty((gh, gw, 2), np.float64)
    for y in range(gh):
        top, bottom = y * cell, min((y + 1) * cell, height)
        for x in range(gw):
            left, right = x * cell, min((x + 1) * cell, width)
            total, bright = 0, 0
            for row in range(top, bottom):
                for col in range(left, right):
                    luma = _luma(rgb[row, col, 0], rgb[row, col, 1], rgb[row, col, 2])
                    total += luma
                    bright += max(luma - 160, 0)
            count = (bottom - top) * (right - left)
            guide[y, x, 0] = total / count
            guide[y, x, 1] = bright / count
    blurred = np.empty_like(guide)
    for y in range(gh):
        for x in range(gw):
            for c in range(2):
                total = 0.0
                for dy in range(-1, 2):
                    row = min(max(y + dy, 0), gh - 1)
                    for dx in range(-1, 2):
                        col = min(max(x + dx, 0), gw - 1)
                        weight = (2 if dy == 0 else 1) * (2 if dx == 0 else 1)
                        total += weight * guide[row, col, c]
                blurred[y, x, c] = total / 16
    return blurred


@njit(cache=True, inline="always")
def _sample_guide(guide, c, y0, y1, x0, x1, fy, fx):
    top = (1 - fx) * guide[y0, x0, c] + fx * guide[y0, x1, c]
    bottom = (1 - fx) * guide[y1, x0, c] + fx * guide[y1, x1, c]
    return (1 - fy) * top + fy * bottom


@njit(cache=True, inline="always")
def _byte(value):
    return int(min(max(value + 0.5, 0), 255))


@njit(cache=True, nogil=True)
def _finish_pixels(rgb, guide, cell, radius, contrast, halation, bleed, split, lut):
    height, width = rgb.shape[:2]
    gh, gw = guide.shape[:2]
    output = np.empty_like(rgb)
    window = radius + 1
    for y in range(height):
        gy = max(0.0, (y + 0.5) / cell - 0.5)
        y0 = int(gy)
        y1, fy = min(y0 + 1, gh - 1), gy - y0
        sum_r = int(rgb[y, 0, 0]) * window
        sum_g = int(rgb[y, 0, 1]) * window
        sum_b = int(rgb[y, 0, 2]) * window
        for x in range(width):
            r, g, b = rgb[y, x]
            luma = _luma(r, g, b)
            detail, glow = 0.0, 0.0
            if gh:
                gx = max(0.0, (x + 0.5) / cell - 0.5)
                x0 = int(gx)
                x1, fx = min(x0 + 1, gw - 1), gx - x0
                if contrast:
                    detail = contrast * (
                        luma - _sample_guide(guide, 0, y0, y1, x0, x1, fy, fx)
                    )
                if halation:
                    glow = halation * max(
                        0.0,
                        _sample_guide(guide, 1, y0, y1, x0, x1, fy, fx)
                        - max(luma - 160, 0),
                    )
            dr, dg, db = 0.0, 0.0, 0.0
            if radius:
                if x:
                    old = max(x - window, 0)
                    sum_r += np.int32(r) - np.int32(rgb[y, old, 0])
                    sum_g += np.int32(g) - np.int32(rgb[y, old, 1])
                    sum_b += np.int32(b) - np.int32(rgb[y, old, 2])
                dr, dg, db = sum_r / window - r, sum_g / window - g, sum_b / window - b
                dy = (4899 * dr + 9617 * dg + 1868 * db) / 16384
                dr, dg, db = bleed * (dr - dy), bleed * (dg - dy), bleed * (db - dy)
            cool, warm = 0.0, 0.0
            if split:
                cool = split * max(0, 128 - luma) / 128 * min(1, luma / 32)
                warm = split * max(0, luma - 128) / 127 * min(1, (255 - luma) / 32)
            output[y, x, 0] = lut[_byte(r + detail + glow + dr + 36 * warm - 14 * cool)]
            output[y, x, 1] = lut[
                _byte(g + detail + 0.28 * glow + dg + 12 * warm - 8 * cool)
            ]
            output[y, x, 2] = lut[
                _byte(b + detail + 0.08 * glow + db - 27 * warm + 40 * cool)
            ]
    return output


def finish_rgb(rgb: np.ndarray, params: FilterParams) -> np.ndarray:
    if not rgb.size:
        return rgb.copy()
    cell = guide_cell(*rgb.shape[:2])
    lut = posterize_lut(params.posterize)
    if not (
        params.local_contrast
        or params.halation
        or params.chroma_bleed
        or params.split_tone
    ):
        return lut[rgb]
    guide = (
        _make_guide(rgb, cell)
        if params.local_contrast or params.halation
        else np.empty((0, 0, 2), np.float64)
    )
    return _finish_pixels(
        rgb,
        guide,
        cell,
        bleed_radius(rgb.shape[1], params.chroma_bleed),
        params.local_contrast / 100,
        params.halation / 100,
        params.chroma_bleed / 100,
        params.split_tone / 100,
        lut,
    )
