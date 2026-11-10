import pytest

from luma_fattal import configuration


@pytest.fixture
def set_size_limits(monkeypatch):
    """Exercise the fixed sizing paths on small test frames."""

    def set_limits(edge=None, *, pixels=None):
        if edge is not None:
            monkeypatch.setattr(configuration, "WORKING_MAX_EDGE", edge)
        if pixels is not None:
            monkeypatch.setattr(configuration, "INPUT_MAX_PIXELS", pixels)

    return set_limits
