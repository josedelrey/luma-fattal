"""Sampled decoder references and file-versus-pixel API contracts."""

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from luma_fattal import Config, FilterParams, apply_filter
from luma_fattal.cli import main
from luma_fattal.image_io import decode_input
from luma_fattal.processing import input_size, resize_bilinear_fixed

FIXTURES = Path(__file__).parent / "fixtures"
GEOMETRY_REFERENCE = json.loads((FIXTURES / "input-geometry.json").read_text())
NOISE_REFERENCE = json.loads((FIXTURES / "decode-noise.json").read_text())


@pytest.mark.parametrize("row", GEOMETRY_REFERENCE["sizes"])
def test_area_fit_matches_geometry_references(row):
    assert list(input_size(tuple(row["source"]), row["limit"])) == row["target"]


@pytest.mark.parametrize(
    "pattern,rows",
    [
        ("pattern", GEOMETRY_REFERENCE["decoders"]),
        ("noise", NOISE_REFERENCE["decoders"]),
    ],
)
@pytest.mark.parametrize("index", range(8))
def test_file_sampling_matches_reference_rgb(pattern, rows, index):
    row = rows[index]
    codec = row["id"].split("_")[0]
    cap = {1: None, 2: 100, 3: 50, 4: 25}[row["sample"]]
    with Image.open(FIXTURES / f"decode-{pattern}.{codec}") as original:
        result = decode_input(original, cap, True)
        assert result.size == (row["width"], row["height"])
        assert np.asarray(result).tobytes().hex() == row["rgb_hex"]
        assert original.size == (24, 19)


def test_loaded_jpeg_is_an_already_decoded_pixel_input():
    with Image.open(FIXTURES / "decode-pattern.jpg") as original:
        original.load()
        assert decode_input(original, 100, True) is original


@pytest.mark.parametrize("pillow", [False, True])
@pytest.mark.parametrize("codec", ["png", "jpg"])
def test_fade_identity_bypasses_input_and_working_limits(
    pillow, codec, set_size_limits
):
    set_size_limits(4, pixels=100)
    source = FIXTURES / f"decode-pattern.{codec}"
    with Image.open(source) as image:
        pixels = np.asarray(image).copy()
    config = Config(
        parameters=FilterParams(fade=100),
    )
    if pillow:
        with Image.open(source) as image:
            result = apply_filter(image, config=config)
            assert result is not image
    else:
        result = apply_filter(pixels, config=config)
        assert result is not pixels
    np.testing.assert_array_equal(np.asarray(result), pixels)


def test_import_limit_applies_when_filtering(set_size_limits):
    set_size_limits(pixels=100)
    pixels = np.asarray(Image.open(FIXTURES / "decode-pattern.png"))
    assert apply_filter(pixels).shape == (8, 11, 3)
    assert input_size((4000, 2000), 8_000_000) == (4000, 2000)
    assert input_size((3264, 2448), 8_000_000) == (3264, 2448)


def test_legacy_core_profile_fits_straight_rgba_to_fixed_limits(set_size_limits):
    set_size_limits(4, pixels=16)
    pixels = np.random.default_rng(6).integers(0, 256, (6, 6, 4), np.uint8)
    result = apply_filter(pixels, profile="core")
    assert result.shape == (4, 4, 4)
    expected_alpha = resize_bilinear_fixed(pixels[..., 3:], (4, 4))[..., 0]
    np.testing.assert_array_equal(result[..., 3], expected_alpha)


@pytest.mark.parametrize("fade", [0, 100])
def test_cli_records_sampling_and_evaluation_uses_matching_geometry(
    tmp_path, capsys, fade, set_size_limits
):
    set_size_limits(pixels=100)
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    source = inputs / "pattern.png"
    source.write_bytes((FIXTURES / "decode-pattern.png").read_bytes())
    destination = tmp_path / "out.png"
    options = [
        "--fade",
        str(fade),
        "--output-format",
        "png",
    ]
    main(["apply", str(source), str(destination), *options])
    metadata = json.loads(destination.with_suffix(".meta.json").read_text())
    if fade == 100:
        assert metadata["input_decode"] is None
        assert metadata["color_conversion"] is None
        assert metadata["resolved_processing"]["prepared_dimensions"] == [24, 19]
        with Image.open(destination) as result, Image.open(source) as original:
            assert result.tobytes() == original.tobytes()
    else:
        assert metadata["input_decode"]["sample"] == 2
        assert metadata["input_decode"]["decoded_dimensions"] == [12, 9]
        assert metadata["resolved_processing"]["prepared_dimensions"] == [11, 8]
    refs = tmp_path / "refs/fattal_1"
    refs.mkdir(parents=True)
    (refs / "pattern.png").write_bytes(destination.read_bytes())
    main(
        [
            "evaluate",
            str(inputs),
            str(refs.parent),
            str(tmp_path / "evaluation"),
            "--filter",
            "fattal1",
            *options,
        ]
    )
    report = json.loads((tmp_path / "evaluation/evaluation.json").read_text())
    assert report["records"][0]["metrics"]["mae"] == 0
    assert (
        tmp_path / "evaluation/comparisons/fattal_1/pattern/differences.png"
    ).exists()
