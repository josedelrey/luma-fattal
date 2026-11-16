"""Start Windows media tools in a job before their launchers can spawn children."""

from __future__ import annotations

import ctypes as ct
import time
from ctypes import wintypes as wt

CREATE_SUSPENDED = 0x00000004
THREAD_SNAPSHOT = 0x00000004
THREAD_SUSPEND_RESUME = 0x00000002
JOB_BASIC_ACCOUNTING = 1
INVALID_HANDLE = ct.c_void_p(-1).value
INVALID_RESUME_COUNT = 0xFFFFFFFF


class _ThreadEntry(ct.Structure):
    _fields_ = [
        ("size", wt.DWORD),
        ("usage", wt.DWORD),
        ("thread_id", wt.DWORD),
        ("process_id", wt.DWORD),
        ("base_priority", wt.LONG),
        ("delta_priority", wt.LONG),
        ("flags", wt.DWORD),
    ]


class _JobAccounting(ct.Structure):
    _fields_ = [
        ("total_user", ct.c_int64),
        ("total_kernel", ct.c_int64),
        ("period_user", ct.c_int64),
        ("period_kernel", ct.c_int64),
        ("page_faults", wt.DWORD),
        ("total_processes", wt.DWORD),
        ("active_processes", wt.DWORD),
        ("terminated_processes", wt.DWORD),
    ]


_kernel = ct.WinDLL("kernel32", use_last_error=True)


def _bind(name, result, *arguments):
    function = getattr(_kernel, name)
    function.restype = result
    function.argtypes = arguments
    return function


_snapshot = _bind("CreateToolhelp32Snapshot", wt.HANDLE, wt.DWORD, wt.DWORD)
_first = _bind("Thread32First", wt.BOOL, wt.HANDLE, ct.POINTER(_ThreadEntry))
_next = _bind("Thread32Next", wt.BOOL, wt.HANDLE, ct.POINTER(_ThreadEntry))
_open_thread = _bind("OpenThread", wt.HANDLE, wt.DWORD, wt.BOOL, wt.DWORD)
_resume = _bind("ResumeThread", wt.DWORD, wt.HANDLE)
_close = _bind("CloseHandle", wt.BOOL, wt.HANDLE)
_create_job = _bind("CreateJobObjectW", wt.HANDLE, ct.c_void_p, wt.LPCWSTR)
_assign = _bind("AssignProcessToJobObject", wt.BOOL, wt.HANDLE, wt.HANDLE)
_terminate = _bind("TerminateJobObject", wt.BOOL, wt.HANDLE, wt.UINT)
_accounting = _bind(
    "QueryInformationJobObject",
    wt.BOOL,
    wt.HANDLE,
    ct.c_int,
    ct.POINTER(_JobAccounting),
    wt.DWORD,
    ct.c_void_p,
)


def _resume_process(pid):
    snapshot = _snapshot(THREAD_SNAPSHOT, 0)
    if snapshot == INVALID_HANDLE:
        raise ct.WinError(ct.get_last_error())
    try:
        entry = _ThreadEntry()
        entry.size = ct.sizeof(entry)
        found = _first(snapshot, ct.byref(entry))
        while found and entry.process_id != pid:
            entry.size = ct.sizeof(entry)
            found = _next(snapshot, ct.byref(entry))
        if not found:
            raise ct.WinError(ct.get_last_error())
        thread = _open_thread(THREAD_SUSPEND_RESUME, False, entry.thread_id)
        if not thread:
            raise ct.WinError(ct.get_last_error())
        try:
            if _resume(thread) == INVALID_RESUME_COUNT:
                raise ct.WinError(ct.get_last_error())
        finally:
            _close(thread)
    finally:
        _close(snapshot)


class MediaJob:
    def __init__(self, process):
        job = _create_job(None, None)
        # Some host jobs forbid nesting. Leave those launches on the tree fallback.
        if job and not _assign(job, int(process._handle)):
            _close(job)
            job = None
        self.job = job
        try:
            _resume_process(process.pid)
        except OSError:
            self.close()
            raise

    def stop(self):
        if not self.job or not _terminate(self.job, 1):
            return False
        # The launcher can exit before its descendants release their files.
        accounting = _JobAccounting()
        deadline = time.monotonic() + 5
        while (
            _accounting(
                self.job,
                JOB_BASIC_ACCOUNTING,
                ct.byref(accounting),
                ct.sizeof(accounting),
                None,
            )
            and accounting.active_processes
        ):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        return True

    def close(self):
        if self.job:
            _close(self.job)
            self.job = None
