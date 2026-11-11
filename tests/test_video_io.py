"""Frame ownership, partial I/O, and failure propagation across workers."""

import hashlib
import io
from types import SimpleNamespace

import numpy as np
import pytest

from luma_fattal.video_io import PooledVideoIO


class ShortPipe(io.BytesIO):
    def readinto(self, target):
        return super().readinto(target[:7])

    def write(self, value):
        return super().write(value[:11])

    def close(self):
        pass


class Process:
    def __init__(self, *, stdin=None, stdout=None):
        self.stdin = stdin
        self.stdout = stdout
        self.terminated = False

    def poll(self):
        return -1 if self.terminated else None

    def terminate(self):
        self.terminated = True


def test_pool_preserves_frame_order_and_padding_with_partial_io():
    source = np.arange(7 * 2 * 3 * 3, dtype=np.uint8).reshape(7, 2, 3, 3)
    decoder, encoder = (
        Process(stdout=ShortPipe(source.tobytes())),
        Process(stdin=ShortPipe()),
    )
    processor = SimpleNamespace(output_buffer=None)
    digest = hashlib.sha256()
    addresses = set()
    with PooledVideoIO(
        decoder, encoder, (2, 3, 3), (2, 3, 3), (2, 4, 3), 2, processor=processor
    ) as pool:
        for frame in pool.frames():
            addresses.add(frame.ctypes.data)
            np.copyto(processor.output_buffer, 255 - frame)
            pool.submit(processor.output_buffer, digest)
        pool.finish()
    expected = np.pad(255 - source, ((0, 0), (0, 0), (0, 1), (0, 0)), mode="edge")
    assert encoder.stdin is not None
    assert encoder.stdin.getvalue() == expected.tobytes()
    assert digest.hexdigest() == hashlib.sha256(expected.tobytes()).hexdigest()
    assert len(addresses) <= 2
    assert processor.output_buffer is None
    assert not pool.reader.is_alive() and not pool.writer.is_alive()


def test_pool_retains_multiple_input_slots_until_their_outputs_are_submitted():
    source = np.arange(6 * 2 * 3 * 3, dtype=np.uint8).reshape(6, 2, 3, 3)
    decoder, encoder = (
        Process(stdout=ShortPipe(source.tobytes())),
        Process(stdin=ShortPipe()),
    )
    digest = hashlib.sha256()
    with PooledVideoIO(decoder, encoder, (2, 3, 3), (2, 3, 3), (2, 3, 3), 3) as pool:
        pending = []
        for frame in pool.frames():
            pending.append((pool.current, frame))
            if len(pending) == 3:
                slot, original = pending.pop(0)
                pool.submit_slot(slot, 255 - original, digest)
        for slot, original in pending:
            pool.submit_slot(slot, 255 - original, digest)
        pool.finish()
    assert encoder.stdin is not None
    assert encoder.stdin.getvalue() == (255 - source).tobytes()
    assert digest.hexdigest() == hashlib.sha256((255 - source).tobytes()).hexdigest()


def test_pool_propagates_decoder_failure_and_stops_workers():
    decoder = Process(stdout=ShortPipe(bytes(19)))
    encoder = Process(stdin=ShortPipe())
    pool = PooledVideoIO(decoder, encoder, (2, 3, 3), (2, 3, 3), (2, 3, 3), 2)
    with pytest.raises(ValueError, match="incomplete"):
        with pool:
            for frame in pool.frames():
                pool.submit(frame, hashlib.sha256())
            pool.finish()
    assert decoder.terminated and encoder.terminated
    assert not pool.reader.is_alive() and not pool.writer.is_alive()


def test_pool_propagates_encoder_failure_without_reusing_its_slot():
    class BrokenPipe(ShortPipe):
        def write(self, value):
            raise BrokenPipeError("controlled encoder failure")

    decoder = Process(stdout=ShortPipe(bytes(5 * 18)))
    encoder = Process(stdin=BrokenPipe())
    pool = PooledVideoIO(decoder, encoder, (2, 3, 3), (2, 3, 3), (2, 3, 3), 2)
    with pytest.raises(BrokenPipeError, match="controlled"):
        with pool:
            for frame in pool.frames():
                pool.submit(frame, hashlib.sha256())
            pool.finish()
    assert not pool.reader.is_alive() and not pool.writer.is_alive()
