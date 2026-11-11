"""Contracts for the post-reconstruction tone controls."""

import numpy as np

from luma_fattal import Config, FilterParams
from luma_fattal.core import _adjust_tones, _boost_vibrance


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


def test_effect_settings_round_trip_and_old_defaults():
    config = Config(parameters=FilterParams(brightness=12, contrast=-20, curve_50=65))
    assert Config.from_dict(config.to_dict()) == config
    old = config.to_dict()
    for key in (
        "brightness",
        "contrast",
        "curve_0",
        "curve_25",
        "curve_50",
        "curve_75",
        "curve_100",
    ):
        del old["parameters"][key]
    assert Config.from_dict(old).parameters.curve_50 == 50


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

    import pytest

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
