"""Entry point for the frozen desktop backend."""

import sys

from luma_fatal.ui.server import main


def self_test() -> None:
    import numpy as np

    from luma_fatal.core import _gaussian3_pass

    sample = np.ones((4, 4), dtype=np.float32)
    result = _gaussian3_pass(sample)
    if result.shape != (2, 2) or not np.allclose(result, 1):
        raise RuntimeError("Numba processing check failed")
    print("Numba processing check passed", flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        main()
