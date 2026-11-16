"""Cross-Scale recipes and rendering through the shared entry points."""

import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from scipy.ndimage import gaussian_filter

from luma_fattal import (
    Config,
    CrossScaleConfig,
    apply_filter,
    cross_scale,
    process_frames,
)
from luma_fattal.cli import main
from luma_fattal.gpu import GPUUnavailable
from luma_fattal.gpu_core import CudaCore

RECIPES = Path(__file__).resolve().parents[1] / "configs"


@pytest.fixture
def textured_ramps():
    y, x = np.mgrid[:160, :256]
    # Two edges of different strengths with the same fine texture.
    coarse = 28 * np.tanh((x - 55) / 7) + 3 * np.tanh((x - 195) / 7)
    fine = 3 * np.sin(np.pi / 2 * y)
    gray = np.round(120 + coarse + fine).astype(np.uint8)
    return np.repeat(gray[..., None], 3, axis=2)


def _detail_contrast(rgb, x):
    gray = rgb[..., 0].astype(np.float32)
    details = (gray - gaussian_filter(gray, 1.2))[35:125, x - 5 : x + 5]
    return float(np.std(details - details.mean(axis=0)))


def test_cross_scale_locally_changes_fine_gradients(textured_ramps):
    config = Config.load(RECIPES / "normal/fattal-1.yaml")
    source = textured_ramps
    fattal = apply_filter(source, config=config)
    neutral = cross_scale(source, config=config, strength=0)
    engrave = cross_scale(source, config=config, strength=100)
    smooth = cross_scale(source, config=config, coupling="smooth", strength=100)

    np.testing.assert_array_equal(neutral, fattal)
    before, after = _detail_contrast(fattal, 55), _detail_contrast(engrave, 55)
    assert _detail_contrast(smooth, 55) < before < after
    assert after / before > _detail_contrast(engrave, 195) / _detail_contrast(
        fattal, 195
    )


def test_cross_scale_presets_match_fattal_one_settings():
    originals = sorted(
        path
        for path in (RECIPES / "normal").glob("*.yaml")
        if not path.name.startswith("fattal-2")
    )
    cross_scale_names = {path.name for path in (RECIPES / "cross-scale").glob("*.yaml")}
    assert cross_scale_names == {
        path.name.replace("fattal-1", "cross-scale") for path in originals
    }
    for original in originals:
        config = Config.load(
            RECIPES / "cross-scale" / original.name.replace("fattal-1", "cross-scale")
        )
        assert config.active_cross_scale == CrossScaleConfig()
        assert replace(config, mode="normal") == Config.load(original)


@pytest.mark.parametrize("suffix", ["yaml", "toml", "json"])
def test_cli_writes_cross_scale_recipe(tmp_path, suffix):
    recipe = tmp_path / f"cross-scale.{suffix}"
    main(
        [
            "config",
            "--mode",
            "cross-scale",
            "--coupling",
            "smooth",
            "--coupling-strength",
            "72.5",
            "--output",
            str(recipe),
        ]
    )
    assert Config.load(recipe) == Config(
        mode="cross-scale", cross_scale=CrossScaleConfig("smooth", 72.5)
    )


def test_cli_image_and_decoded_frames_use_same_coupling(tmp_path, textured_ramps):
    source, result = tmp_path / "input.png", tmp_path / "output.png"
    Image.fromarray(textured_ramps).save(source)
    recipe = RECIPES / "cross-scale/default.yaml"
    main(
        [
            "apply",
            str(source),
            str(result),
            "--config",
            str(recipe),
            "--coupling",
            "smooth",
            "--output-format",
            "png",
        ]
    )
    config = replace(Config.load(recipe), cross_scale=CrossScaleConfig("smooth"))
    with Image.open(result) as output:
        np.testing.assert_array_equal(
            output, next(process_frames([textured_ramps], config=config))
        )
    metadata = json.loads(result.with_suffix(".meta.json").read_text())
    assert Config.from_dict(metadata["configuration"]).cross_scale == config.cross_scale


@pytest.mark.parametrize("coupling", ["engrave", "smooth"])
def test_cross_scale_cuda_agrees_with_cpu(textured_ramps, coupling):
    try:
        cuda = CudaCore()
    except GPUUnavailable as error:
        pytest.skip(str(error))
    config = Config(mode="cross-scale", cross_scale=CrossScaleConfig(coupling, 100))
    expected = apply_filter(textured_ramps, config=config)
    actual = cuda(textured_ramps, config)
    np.testing.assert_allclose(expected, actual, atol=1)
