"""Bounded decode and encode workers with reusable RGB frame ownership."""

from __future__ import annotations

from queue import Empty, Full, Queue
from threading import Event, Thread
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from _hashlib import HASH


class _EndOfStream:
    """Mark completion independently of reusable frame slots."""


_FrameSlot = list[np.ndarray]


def read_frame(pipe, array):
    target = memoryview(array).cast("B")
    offset = 0
    while offset < len(target):
        count = pipe.readinto(target[offset:])
        if not count:
            if offset:
                raise ValueError("Decoder returned an incomplete RGB frame")
            return False
        offset += count
    return True


def write_frame(pipe, array):
    data = memoryview(array).cast("B")
    offset = 0
    while offset < len(data):
        count = pipe.write(data[offset:])
        if not count:
            raise OSError("Video encoder stopped accepting RGB data")
        offset += count


class PooledVideoIO:
    """Transfer each slot from decoder to filter to encoder before reuse."""

    def __init__(
        self,
        decoder,
        encoder,
        input_shape,
        output_shape,
        encoded_shape,
        depth,
        *,
        pinned=False,
        processor=None,
    ):
        self.decoder, self.encoder = decoder, encoder
        self.processor = processor
        self.free: Queue[_FrameSlot | _EndOfStream] = Queue(maxsize=depth)
        self.ready: Queue[_FrameSlot | _EndOfStream] = Queue(maxsize=depth)
        self.output: Queue[_FrameSlot | _EndOfStream] = Queue(maxsize=depth)
        self.stop = Event()
        self.errors = []
        self.sentinel = _EndOfStream()
        self.finished = False
        self.current: _FrameSlot | None = None
        self.digest: HASH | None = None
        self.pinned = pinned
        for _ in range(depth):
            source = self._array(input_shape)
            output = self._array(output_shape)
            encoded = (
                output if output_shape == encoded_shape else self._array(encoded_shape)
            )
            slot = [source, output, encoded]
            self.free.put(slot)
        self.reader = Thread(target=self._decode, name="luma-fatal-decode", daemon=True)
        self.writer = Thread(target=self._encode, name="luma-fatal-encode", daemon=True)

    def _array(self, shape):
        if self.pinned:
            try:
                import cupy as cp  # pyright: ignore[reportMissingImports]

                size = int(np.prod(shape))
                memory = cp.cuda.alloc_pinned_memory(size)
                return np.frombuffer(memory, np.uint8, count=size).reshape(shape)
            except Exception:
                self.pinned = False
        return np.empty(shape, np.uint8)

    def _check(self):
        if self.errors:
            raise self.errors[0]

    def _get(
        self, queue: Queue[_FrameSlot | _EndOfStream]
    ) -> _FrameSlot | _EndOfStream:
        while not self.stop.is_set():
            self._check()
            try:
                return queue.get(timeout=0.05)
            except Empty:
                pass
        self._check()
        return self.sentinel

    def _put(self, queue, item):
        while not self.stop.is_set():
            self._check()
            try:
                queue.put(item, timeout=0.05)
                return
            except Full:
                pass
        self._check()

    def _decode(self):
        try:
            while not self.stop.is_set():
                slot = self._get(self.free)
                if isinstance(slot, _EndOfStream):
                    return
                if not read_frame(self.decoder.stdout, slot[0]):
                    self._put(self.ready, self.sentinel)
                    return
                self._put(self.ready, slot)
        except Exception as error:
            self.errors.append(error)
            self.stop.set()

    def _encode(self):
        try:
            while not self.stop.is_set():
                slot = self._get(self.output)
                if isinstance(slot, _EndOfStream):
                    return
                assert self.digest is not None
                self.digest.update(slot[2].data.cast("B"))
                write_frame(self.encoder.stdin, slot[2])
                self._put(self.free, slot)
        except Exception as error:
            self.errors.append(error)
            self.stop.set()

    def __enter__(self):
        self.reader.start()
        self.writer.start()
        return self

    def frames(self):
        while True:
            slot = self._get(self.ready)
            if isinstance(slot, _EndOfStream):
                return
            self.current = slot
            if self.processor is not None:
                self.processor.output_buffer = slot[1]
            yield slot[0]

    def submit(self, frame, digest):
        self._check()
        slot = self.current
        assert slot is not None
        if frame is not slot[1]:
            np.copyto(slot[1], frame)
        encoded = slot[2]
        h, w = frame.shape[:2]
        if encoded is not slot[1]:
            encoded[:h, :w] = frame
            encoded[:h, w:] = frame[:, -1:]
            encoded[h:] = encoded[h - 1 : h]
        self.digest = digest
        self._put(self.output, slot)
        self.current = None

    def finish(self):
        self._put(self.output, self.sentinel)
        while self.writer.is_alive():
            self.writer.join(timeout=0.05)
            self._check()
        self.reader.join(timeout=1)
        self._check()
        self.encoder.stdin.close()
        self.finished = True

    def __exit__(self, kind, error, traceback):
        self.stop.set()
        if not self.finished:
            for process in (self.decoder, self.encoder):
                if process.poll() is None:
                    process.terminate()
        for worker in (self.reader, self.writer):
            worker.join(timeout=1)
        if self.processor is not None:
            self.processor.output_buffer = None
