"""Contracts for the post-reconstruction tone controls."""

import numpy as np
import pytest

from luma_fattal import Config, FilterParams, NumericsConfig
from luma_fattal.core import _adjust_tones, _boost_vibrance
from luma_fattal.finishing import finish_rgb
from luma_fattal.processing import process_pixels


def test_tone_adjustments_apply_curve_after_brightness_and_contrast():
    rgb = np.array([[[0.0, 63.75, 127.5], [191.25, 255.0, 127.5]]])
    curve = (0.0, 10.0, 50.0, 90.0, 100.0)
    result = _adjust_tones(rgb, 0, 0, curve)
    np.testing.assert_allclose(result[0, 0], [0, 25.5, 127.5])
    np.testing.assert_allclose(result[0, 1], [229.5, 255, 127.5])
    flat = _adjust_tones(rgb, 10, -100, (0, 25, 50, 75, 100))
    np.testing.assert_allclose(flat, 153.0)


def test_vibrance_extended_range_has_more_effect():
    rgb = np.array([[[120.0, 100.0, 90.0]]])
    normal = _boost_vibrance(rgb, 100)
    strong = _boost_vibrance(rgb, 500)
    assert np.ptp(strong) > np.ptp(normal) > np.ptp(rgb)


@pytest.mark.parametrize(
    "strength,fade,expected",
    [
        (0, 0, [70, 70, 150, 150]),
        (100, 0, [70, 50, 170, 150]),
        (1000, 0, [70, 0, 255, 150]),
        (1000, 50, [70, 35, 202, 150]),
        (1000, 100, [70, 70, 150, 150]),
    ],
)
def test_sharpen_increases_edge_contrast_before_fade(strength, fade, expected):
    rgb = np.broadcast_to(
        np.array([70, 70, 150, 150], np.uint8)[None, :, None], (3, 4, 3)
    )
    output = process_pixels(
        rgb,
        1,
        FilterParams(tone_strength=0, sharpen=strength, fade=fade),
        numerics=NumericsConfig(power_mode="standard"),
    )
    np.testing.assert_array_equal(
        output, np.broadcast_to(np.array(expected)[None, :, None], rgb.shape)
    )


def test_effect_settings_round_trip_and_old_defaults():
    config = Config(
        parameters=FilterParams(brightness=12, contrast=-20, curve_50=65, sharpen=250)
    )
    assert Config.from_dict(config.to_dict()) == config
    old = config.to_dict()
    for key in (
        "brightness",
        "contrast",
        "sharpen",
        "curve_0",
        "curve_25",
        "curve_50",
        "curve_75",
        "curve_100",
    ):
        del old["parameters"][key]
    defaults = Config.from_dict(old).parameters
    assert defaults.curve_50 == 50
    assert defaults.sharpen == 0


def test_local_contrast_and_halation_spread_across_a_brightness_edge():
    rgb = np.full((16, 32, 3), 90, np.uint8)
    rgb[:, 16:] = 210
    contrast = finish_rgb(rgb, FilterParams(local_contrast=100))
    assert contrast[8, 15, 0] < 90 < 210 < contrast[8, 16, 0]
    np.testing.assert_array_equal(contrast[:, [0, -1]], rgb[:, [0, -1]])
    halation = finish_rgb(rgb, FilterParams(halation=200))
    red, green, blue = halation[8, 15]
    assert red > green > blue >= 90
    np.testing.assert_array_equal(halation[:, 16:], rgb[:, 16:])


def test_chroma_bleed_trails_color_without_smearing_the_brightness_edge():
    rgb = np.full((3, 12, 3), (180, 80, 70), np.uint8)
    rgb[:, 6:] = (80, 140, 180)
    bled = finish_rgb(rgb, FilterParams(chroma_bleed=100))
    np.testing.assert_array_equal(bled[:, :6], rgb[:, :6])
    assert bled[0, 6, 0] > rgb[0, 6, 0]
    assert bled[0, 6, 2] < rgb[0, 6, 2]
    weights = np.array([4899, 9617, 1868]) / 16384
    np.testing.assert_allclose(bled @ weights, rgb @ weights, atol=0.5)


def test_split_tone_tints_each_end_and_posterize_quantizes_last():
    shades = np.array([0, 45, 128, 210, 255], np.uint8)
    rgb = np.repeat(shades[None, :, None], 3, axis=2)
    tinted = finish_rgb(rgb, FilterParams(split_tone=100))
    assert tinted[0, 1, 2] > 45 > tinted[0, 1, 0]
    assert tinted[0, 3, 0] > 210 > tinted[0, 3, 2]
    np.testing.assert_array_equal(tinted[:, [0, 2, 4]], rgb[:, [0, 2, 4]])
    both = finish_rgb(rgb, FilterParams(split_tone=100, posterize=100))
    np.testing.assert_array_equal(both, finish_rgb(tinted, FilterParams(posterize=100)))
    assert set(both.ravel()) == {0, 85, 170, 255}


def test_recombine_applies_tone_controls():
    from luma_fattal.core import _recombine

    rgb = np.array([[[64, 128, 192]]], dtype=np.uint8)
    luminance = np.array([[0.5]], dtype=np.float32)
    baseline = _recombine(rgb, luminance, luminance, 100, power_mode="standard")
    adjusted = _recombine(
        rgb,
        luminance,
        luminance,
        100,
        power_mode="standard",
        brightness=10,
        curve=(0, 25, 65, 75, 100),
    )
    assert np.all(adjusted > baseline)


@pytest.mark.parametrize("softness", [0, 6])
@pytest.mark.parametrize("post", [
    {"brightness": 10},
    {"output_gamma": 2},
    {"curve": (20, 25, 50, 75, 100)},
    {"vibrance": 100},
    {"highlight_compression": 100},
])
def test_post_adjustments_apply_after_shadow_protection(softness, post):
    from luma_fattal.core import _recombine

    rgb = np.array([[[6, 4, 2], [200, 210, 220]]], dtype=np.uint8)
    luminance = np.array([[6 / 255, 210 / 255]], dtype=np.float32)
    mapped = np.array([[0.8, 0.8]], dtype=np.float32)
    protected = _recombine(rgb, luminance, mapped, 100, power_mode="standard", shadow_softness=softness)
    # Compare with the same post effect applied to the protected image. The
    # intermediate byte rounding can differ by at most one code value.
    reference_lum = np.array([[20 / 255, 210 / 255]], dtype=np.float32)
    actual = _recombine(rgb, luminance, mapped, 100, power_mode="standard", shadow_softness=softness, **post)
    expected = _recombine(protected, reference_lum, reference_lum, 100, power_mode="standard", shadow_threshold=-1, **post)
    np.testing.assert_allclose(actual, expected, atol=2)


@pytest.mark.parametrize("shape", [(4, 4, 3), (1, 1, 3)])
def test_brightness_applies_to_black_and_identity_fallback_frames(shape):
    rgb = np.zeros(shape, np.uint8)
    if shape[0] == 1:
        with pytest.warns(RuntimeWarning, match="identity extension"):
            output = process_pixels(rgb, 1, FilterParams(brightness=10))
    else:
        output = process_pixels(rgb, 1, FilterParams(brightness=10))
    np.testing.assert_array_equal(output, np.full(shape, 26, np.uint8))


def test_curve_interpolates_smoothly_without_overshooting():
    curve = (0.0, 20.0, 80.0, 30.0, 100.0)
    values = np.linspace(0, 255, 401).reshape(1, -1, 1)
    output = _adjust_tones(values, 0, 0, curve).reshape(-1) / 2.55
    np.testing.assert_allclose(output[::100], curve)
    assert np.all((output[:101] >= 0) & (output[:101] <= 20))
    assert np.all((output[100:201] >= 20 - 1e-10) & (output[100:201] <= 80 + 1e-10))
    assert np.all((output[200:301] >= 30 - 1e-10) & (output[200:301] <= 80 + 1e-10))
    assert output[150] != 50


def test_curve_drawing_matches_processing():
    import json
    import shutil
    import subprocess
    from pathlib import Path

    if not shutil.which("node"):
        pytest.skip("Node.js is required")
    script = Path(__file__).resolve().parents[1] / "src/luma_fattal/ui/settings.js"
    points = [0, 20, 80, 30, 100]
    positions = [0, 0.5, 1.2, 2.75, 4]
    result = subprocess.run(
        [
            "node",
            "-e",
            "const {curveValue}=require(process.argv[1]); const p=JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify(JSON.parse(process.argv[3]).map(x=>curveValue(p,x))))",
            str(script),
            json.dumps(points),
            json.dumps(positions),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    rgb = (np.array(positions) * 63.75).reshape(1, -1, 1)
    np.testing.assert_allclose(
        json.loads(result.stdout),
        _adjust_tones(rgb, 0, 0, tuple(points)).reshape(-1) / 2.55,
    )


def test_curve_keyboard_reset_and_no_visible_sliders():
    import json
    import shutil
    import subprocess
    from pathlib import Path

    if not shutil.which("node"):
        pytest.skip("Node.js is required")
    script = Path(__file__).resolve().parents[1] / "src/luma_fattal/ui/settings.js"
    js = r"""
const assert = require('node:assert/strict');
class Element {
  constructor() { this.children=[]; this.attributes={}; this.dataset={}; this.validity={valid:true}; }
  append(...children) { this.children.push(...children); }
  setAttribute(k,v) { this.attributes[k]=v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(k,fn) { this[k]=fn; }
  setCustomValidity() {}
  get valueAsNumber() { return Number(this.value); }
}
global.document={createElement:()=>new Element()};
const {ConfigurationPanel}=require(process.argv[1]);
const advanced=new Element(), panel=new ConfigurationPanel(new Element(),advanced,()=>{});
const config=JSON.parse(process.argv[2]); panel.load(config);
assert.ok(!advanced.children[0].children.some(e=>e.dataset.setting?.startsWith('parameters.curve_')));
const event=key=>({key,preventDefault(){}});
assert.equal(panel.curves.length, 2);
assert.deepEqual(panel.curves.map(c => c.prefix), ['pre_curve_', 'curve_']);
for (const [index, key] of [[0, 'pre_curve_25'], [1, 'curve_25']]) {
  const editor = panel.curves[index];
  assert.equal(editor.wrapper.children[1], editor.curve);
  assert.equal(editor.wrapper.children[2].dataset.setting, index ? 'parameters.post_curve_wet' : 'parameters.pre_curve_wet');
  assert.equal(editor.wrapper.children[3], editor.resetCurve);
  editor.curve.keydown(event('ArrowRight'));
  editor.curve.keydown(event('ArrowUp'));
  assert.equal(config.parameters[key], 26);
  editor.resetCurve.click();
  assert.equal(config.parameters[key], 25);
}
"""
    subprocess.run(
        ["node", "-e", js, str(script), json.dumps(Config().to_dict())],
        capture_output=True,
        text=True,
        check=True,
    )


def test_curve_wet_blends_in_curve_space():
    values = np.array([[[63.75, 127.5, 191.25]]])
    curve = (0, 40, 65, 90, 100)
    dry = _adjust_tones(values, 0, 0, curve, 0)
    full = _adjust_tones(values, 0, 0, curve, 100)
    half = _adjust_tones(values, 0, 0, curve, 50)
    np.testing.assert_allclose(dry, values)
    np.testing.assert_allclose(half, (dry + full) / 2)


def test_pre_curve_feeds_filter_and_preserves_original_for_fade():
    from dataclasses import replace

    from luma_fattal import NumericsConfig
    from luma_fattal.core import apply_core

    rgb = np.arange(12 * 12 * 3, dtype=np.uint16).reshape(12, 12, 3).astype(np.uint8)
    captured = []

    def cleanup(pixels, luminance):
        captured.append(pixels.copy())
        return pixels.astype(np.float32), luminance

    params = FilterParams(pre_curve_50=80, pre_curve_wet=100, fade=50)
    numerics = NumericsConfig(iterations=2)
    apply_core(rgb, 1, params, numerics, source_cleanup=cleanup)
    expected = np.floor(
        _adjust_tones(rgb.astype(np.float64), 0, 0, (0, 25, 80, 75, 100)) + 0.5
    ).astype(np.uint8)
    np.testing.assert_array_equal(captured[0], expected)
    captured.clear()
    apply_core(
        rgb, 1, replace(params, pre_curve_wet=0), numerics, source_cleanup=cleanup
    )
    np.testing.assert_array_equal(captured[0], rgb)
    np.testing.assert_array_equal(
        apply_core(rgb, 1, replace(params, fade=100), numerics), rgb
    )


def test_preview_cache_invalidates_for_pre_curve_only():
    from dataclasses import replace

    from luma_fattal.ui.server import _PreviewSamples

    samples = _PreviewSamples.__new__(_PreviewSamples)
    samples.tone_key = None
    samples.tone_maps = {}
    config = Config()
    initial = samples.tone_maps_for(config, [1.0])
    post = replace(config, parameters=replace(config.parameters, curve_50=70))
    assert samples.tone_maps_for(post, [1.0]) is initial
    pre = replace(config, parameters=replace(config.parameters, pre_curve_50=70))
    assert samples.tone_maps_for(pre, [1.0]) is not initial


def test_custom_curve_points_change_processing_and_round_trip():
    points = ((0, 0), (15, 70), (60, 20), (100, 100))
    config = Config(parameters=FilterParams(pre_curve_points=points, curve_points=points))
    restored = Config.from_dict(config.to_dict())
    assert restored.parameters.curve_points == points
    assert restored.parameters.pre_curve_points == points
    assert config.to_yaml()
    pixels = np.array([[[38.25, 153.0, 255.0]]])
    result = _adjust_tones(pixels, 0, 0, tuple(y for _, y in points), 100, tuple(x for x, _ in points))
    np.testing.assert_allclose(result[0, 0] / 2.55, [70, 20, 100])


@pytest.mark.parametrize("curve_name", ["pre_curve_points", "curve_points"])
def test_mixed_integer_and_decimal_curve_points_process(curve_name):
    points = ((0, 0), (20.5, 40), (60, 72.5), (100, 100))
    rgb = np.full((4, 4, 3), 100, dtype=np.uint8)
    float_points = tuple((float(x), float(y)) for x, y in points)
    if curve_name == "pre_curve_points":
        mixed = FilterParams(tone_strength=0, pre_curve_points=points)
        floats = FilterParams(tone_strength=0, pre_curve_points=float_points)
    else:
        mixed = FilterParams(tone_strength=0, curve_points=points)
        floats = FilterParams(tone_strength=0, curve_points=float_points)
    numerics = NumericsConfig(power_mode="standard")
    np.testing.assert_array_equal(
        process_pixels(rgb, 1, mixed, numerics=numerics),
        process_pixels(rgb, 1, floats, numerics=numerics),
    )


def test_custom_curve_points_validation():
    import pytest

    for points in (
        ((0, 0), (20, 30), (20, 40), (100, 100)),
        ((1, 0), (100, 100)),
        ((0, 0), (100, 101)),
    ):
        with pytest.raises(ValueError):
            FilterParams(curve_points=points)


def test_curve_editor_add_drag_delete_points():
    import json
    import shutil
    import subprocess
    from pathlib import Path

    import pytest

    if not shutil.which("node"):
        pytest.skip("Node.js is required")
    script = Path(__file__).resolve().parents[1] / "src/luma_fattal/ui/settings.js"
    js = r"""
const assert = require('node:assert/strict');
class Element {
  constructor() { this.children=[]; this.attributes={}; this.dataset={}; this.validity={valid:true}; }
  append(...children) { this.children.push(...children); }
  setAttribute(k,v) { this.attributes[k]=v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(k,fn) { this[k]=fn; }
  setCustomValidity() {}
  get valueAsNumber() { return Number(this.value); }
  getBoundingClientRect() { return {left:0,top:0,width:256,height:160}; }
  setPointerCapture() { this.captured=true; }
  hasPointerCapture() { return this.captured; }
  focus() {}
}
global.document={createElement:()=>new Element()};
const {ConfigurationPanel}=require(process.argv[1]);
const config=JSON.parse(process.argv[2]);
const panel=new ConfigurationPanel(new Element(),new Element(),()=>{}); panel.load(config);
for (const [index,key] of [[0,'pre_curve_points'],[1,'curve_points']]) {
  const editor=panel.curves[index], canvas=editor.curve;
  canvas.pointerdown({button:0,clientX:97,clientY:30,pointerId:1});
  assert.equal(config.parameters[key].length,6);
  assert.ok(Math.abs(config.parameters[key][2][1] - (1 - 26 / 152) * 100) < 1e-9);
  canvas.pointermove({clientX:105,clientY:90,pointerId:1});
  assert.ok(config.parameters[key][2][0]>40);
  canvas.keydown({key:'Delete',preventDefault(){}});
  assert.equal(config.parameters[key].length,5);
  editor.resetCurve.click();
  assert.equal(config.parameters[key],null);
}
"""
    subprocess.run(
        ["node", "-e", js, str(script), json.dumps(Config().to_dict())],
        capture_output=True,
        text=True,
        check=True,
    )
