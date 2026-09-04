import base64
import builtins
import json
import os
import re
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import TracebackType

linux = os.environ.get("RUNNER_OS", sys.platform) in ("Linux", "linux")
fetch_timeout_seconds = 120 if linux else 90
cleanup_seconds = 10
cancelled = 0
closed = False
git = shutil.which("git")
checkout_environment = {}


def cancel(signum, _frame):
    global cancelled
    cancelled = signum


for signame in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"):
    if hasattr(signal, signame):
        signal.signal(getattr(signal, signame), cancel)


def check_cancelled():
    if cancelled:
        raise SystemExit(128 + cancelled)


# The bootstrap inherits only this Job handle and stdio, joins before spawning Git,
# then closes its copy. Even owner death before assignment kills it on that close.
windows_api = '''
import ctypes as c
from ctypes import wintypes as w
import os, subprocess, sys
kernel = c.WinDLL("kernel32", use_last_error=True)
def checked(value, function, arguments):
    if not value:
        raise c.WinError(c.get_last_error())
    return value
def bind(name, result, *arguments):
    function = getattr(kernel, name)
    function.restype, function.argtypes = result, arguments
    function.errcheck = checked
    return function
close_handle = bind("CloseHandle", w.BOOL, w.HANDLE)
assign = bind("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
current = bind("GetCurrentProcess", w.HANDLE)
'''


if os.name == "nt":
    exec(windows_api)

    class BasicLimits(c.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", c.c_int64), ("PerJobUserTimeLimit", c.c_int64),
            ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", c.c_size_t),
            ("MaximumWorkingSetSize", c.c_size_t), ("ActiveProcessLimit", w.DWORD),
            ("Affinity", c.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD),
        ]

    class IoCounters(c.Structure):
        _fields_ = [(name, c.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimits(c.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters)] + [
            (name, c.c_size_t) for name in (
                "ProcessMemoryLimit", "JobMemoryLimit", "PeakProcessMemoryUsed", "PeakJobMemoryUsed",
            )
        ]

    class Accounting(c.Structure):
        _fields_ = [(name, c.c_int64) for name in (
            "TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime",
        )] + [(name, w.DWORD) for name in (
            "TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses",
        )]

    # Check structure layout validity
    if (c.sizeof(BasicLimits), c.sizeof(ExtendedLimits), c.sizeof(Accounting), Accounting.ActiveProcesses.offset) != (64, 144, 48, 40):
        raise RuntimeError("Unsupported Windows Job structure layout")

    # Bind job creation and management
    create_job = bind("CreateJobObjectW", w.HANDLE, c.c_void_p, w.LPCWSTR)
    set_job = bind("SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
    query_job = bind("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p)
    terminate_job = bind("TerminateJobObject", w.BOOL, w.HANDLE, w.UINT)

    bootstrap = windows_api + '''
job = int(sys.argv[1])
assign(job, current())
close_handle(job)
sys.exit(subprocess.call(sys.argv[2:], stdin=subprocess.DEVNULL))
'''


def group_alive(pgid, deadline=None):
    """Check if the process group leader is still alive."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Darwin can report EPERM for a zombie-only group
        return True


def group_signal(pgid, signum, deadline):
    """Send a signal to a process group, handling edge cases like Darwin zombies."""
    try:
        os.killpg(pgid, signum)
        # If we get here, the process took the signal (or handled it)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # On macOS (Darwin), EPERM can happen with a zombie-only group.
        # Only a checked census proving no live members can authorize continuing.
        if group_alive(pgid, deadline):
            return True  # Signal was valid for an 'alive' zombie
        return False
    except OSError:
        # Catch-all for any other system-specific OS errors
        return True


# Optional entry point if this script is run directly
if __name__ == "__main__":
    main_pid = int(os.environ.get("MAIN_PID", sys.getpid()))
    timeout = int(os.environ.get("TIMEOUT", 120))

    # Monitor the main process group
    group_signal(main_pid, signal.SIGTERM, timeout)
    
    # Simple main loop to trigger signal
    def do_work():
        check_cancelled()
        subprocess.run(["echo", "Working..."])
        check_cancelled()

    do_work()
    print(f"Exited with signal {cancelled}")
    sys.exit(128 + cancelled if cancelled else 0)