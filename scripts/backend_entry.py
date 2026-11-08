"""Entry point for the frozen desktop backend."""

import site
import sys

if getattr(sys, "frozen", False):
    bundled_site = str(getattr(sys, "_MEIPASS"))
    original_site_packages = site.getsitepackages

    def frozen_site_packages() -> list[str]:
        return [bundled_site, *original_site_packages()]

    site.getsitepackages = frozen_site_packages

from luma_fattal.ui.server import main


def self_test() -> None:
    import numpy as np

    from luma_fattal.core import _gaussian3_pass

    sample = np.ones((4, 4), dtype=np.float32)
    result = _gaussian3_pass(sample)
    if result.shape != (2, 2) or not np.allclose(result, 1):
        raise RuntimeError("Numba processing check failed")
    print("Numba processing check passed", flush=True)


def gpu_test(use_device: bool) -> None:
    import cupy as cp
    from cupyx.scipy.ndimage import gaussian_filter

    if use_device:
        sample = cp.arange(16, dtype=cp.float32).reshape(4, 4)
        result = cp.asnumpy(gaussian_filter(sample, sigma=1))
        if result.shape != (4, 4) or not bool((result >= 0).all()):
            raise RuntimeError("CUDA processing check failed")
    print("CUDA dependencies check passed", flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    elif sys.argv[1:] == ["--gpu-import-test"]:
        gpu_test(False)
    elif sys.argv[1:] == ["--gpu-self-test"]:
        gpu_test(True)
    else:
        main()
