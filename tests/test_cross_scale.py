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
from luma_fattal.core import ToneMapSlot, apply_core
from luma_fattal.gpu import GPUUnavailable
from luma_fattal.gpu_core import CudaCore
from luma_fattal.ui.server import _PreviewSamples

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


def test_engrave_can_reverse_relief_on_an_edge_without_fine_texture():
    x = np.arange(256)
    profile = np.round(120 + 28 * np.tanh((x - 100) / 4)).astype(np.uint8)
    rgb = np.broadcast_to(profile[None, :, None], (160, x.size, 3)).copy()
    config = Config.load(RECIPES / "normal/fattal-1.yaml")

    def contrast(strength, relief=100):
        filtered = cross_scale(rgb, config=config, strength=strength, relief=relief)
        bright_side = filtered[40:120, 104, 0].mean()
        dark_side = filtered[40:120, 95, 0].mean()
        return bright_side - dark_side

    assert contrast(0) > contrast(65) > 0
    assert contrast(100, relief=0) > 0 > contrast(100)


def test_maximum_strength_and_relief_round_trip(textured_ramps):
    config = Config(mode="cross-scale", cross_scale=CrossScaleConfig("engrave", 100, 100))
    assert Config.from_dict(config.to_dict()) == config
    output = apply_filter(textured_ramps, config=config)
    assert output.shape == textured_ramps.shape
    assert output.dtype == np.uint8
    extended = replace(config, cross_scale=CrossScaleConfig(strength=500, relief=500, relief_width=2.5))
    assert Config.from_dict(extended.to_dict()) == extended
    assert np.any(apply_filter(textured_ramps, config=extended) != output)
    with pytest.raises(ValueError, match="Combined Cross-Scale"):
        CrossScaleConfig(strength=1e20, relief=1e20)
    for invalid in (-0.1, float("inf")):
        with pytest.raises(ValueError, match=r"cross_scale\.relief_width"):
            CrossScaleConfig(relief_width=invalid)


def test_relief_width_limit_uses_working_image_size(textured_ramps):
    larger = np.tile(textured_ramps, (4, 3, 1))
    config = Config(mode="cross-scale", cross_scale=CrossScaleConfig(relief_width=20))
    assert apply_filter(larger, config=config).shape == larger.shape
    wider = replace(config, cross_scale=replace(config.cross_scale, relief_width=40))
    assert apply_filter(textured_ramps, config=wider).shape == textured_ramps.shape
    with pytest.raises(ValueError, match="Relief width is too large.*768×640.*20.0000"):
        apply_filter(larger, config=wider)


def test_equalizer_blends_fattal_with_cross_scale_and_reuses_solves(textured_ramps, monkeypatch):
    config = Config(mode="cross-scale")
    fine_gains = (100,) * 7 + (0,)
    edited = replace(config, cross_scale=replace(config.cross_scale, eq_gains=fine_gains))
    zero = replace(config, cross_scale=replace(config.cross_scale, eq_gains=(0,) * 8))
    monkeypatch.setattr("luma_fattal.ui.server._probe", lambda *_: {})
    samples = _PreviewSamples(Path("unused.mp4"), config)
    slot = samples.tone_maps_for(config, [0.0])[0.0].cpu

    def render(recipe, **options):
        return apply_core(
            textured_ramps, 1, recipe.parameters, recipe.numerics,
            cross_scale=recipe.active_cross_scale, **options,
        )

    base = render(config, tone_map=slot)
    fattal = render(Config())
    np.testing.assert_array_equal(render(zero, tone_map=slot), fattal)
    expected = render(edited)
    assert np.any(expected != base)
    assert np.any(expected != fattal)
    assert samples.tone_maps_for(edited, [0.0])[0.0].cpu is slot

    def unexpected_solve(*_):
        pytest.fail("Changing an equalizer band must reuse the preview solve")

    np.testing.assert_array_equal(render(edited, tone_map=slot, solver=unexpected_solve), expected)


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
            "engrave",
            "--coupling-strength",
            "72.5",
            "--relief",
            "38.25",
            "--relief-width",
            "1.5",
            "--eq-gains",
            *["100"] * 7,
            "150",
            "--output",
            str(recipe),
        ]
    )
    assert Config.load(recipe) == Config(
        mode="cross-scale",
        cross_scale=CrossScaleConfig(
            "engrave", 72.5, 38.25, relief_width=1.5, eq_gains=(100,) * 7 + (150,)
        ),
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
            "--relief",
            "38.25",
            "--relief-width",
            "0.5",
            "--output-format",
            "png",
        ]
    )
    config = replace(
        Config.load(recipe), cross_scale=CrossScaleConfig(relief=38.25, relief_width=0.5)
    )
    with Image.open(result) as output:
        np.testing.assert_array_equal(
            output, next(process_frames([textured_ramps], config=config))
        )
    metadata = json.loads(result.with_suffix(".meta.json").read_text())
    assert Config.from_dict(metadata["configuration"]).cross_scale == config.cross_scale


@pytest.mark.parametrize(
    "coupling,relief,width",
    [
        ("engrave", 100, 1),
        ("smooth", 100, 1),
        ("engrave", 0, 2),
        ("engrave", 100, 0.5),
        ("engrave", 100, 2),
        ("engrave", 100, 20),
    ],
)
def test_cross_scale_cuda_agrees_with_cpu(textured_ramps, coupling, relief, width):
    try:
        cuda = CudaCore()
    except GPUUnavailable as error:
        pytest.skip(str(error))
    config = Config(
        mode="cross-scale",
        cross_scale=CrossScaleConfig(coupling, 100, relief, relief_width=width),
    )
    expected = apply_filter(textured_ramps, config=config)
    actual = cuda(textured_ramps, config)
    np.testing.assert_allclose(expected, actual, atol=1)


def test_equalizer_cuda_reuses_distinct_maps_with_shared_buffers(textured_ramps):
    try:
        cuda = CudaCore()
    except GPUUnavailable as error:
        pytest.skip(str(error))
    config = Config(mode="cross-scale")
    config = replace(config, video=replace(config.video, gpu_buffer_reuse=True))
    zero = replace(config, cross_scale=replace(config.cross_scale, eq_gains=(0,) * 8))
    mixed = replace(config, cross_scale=replace(config.cross_scale, eq_gains=(100,) * 6 + (50, 0)))
    samples = ToneMapSlot()
    normal = cuda(textured_ramps, replace(config, mode="normal"))
    np.testing.assert_array_equal(cuda(textured_ramps, zero, tone_map=samples), normal)
    expected = apply_filter(textured_ramps, config=mixed)
    np.testing.assert_allclose(cuda(textured_ramps, mixed, tone_map=samples), expected, atol=1)
    np.testing.assert_array_equal(cuda(textured_ramps, zero, tone_map=samples), normal)
