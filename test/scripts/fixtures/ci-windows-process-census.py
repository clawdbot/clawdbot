"""Read exact Windows process lifetimes for the checkout fixture."""
import ctypes as c
from ctypes import wintypes as w
import json
import sys


def read_processes(pids):
    kernel = c.WinDLL("kernel32", use_last_error=True)

    def bind(name, result, *arguments):
        function = getattr(kernel, name)
        function.restype, function.argtypes = result, arguments
        return function

    open_process = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    process_times = bind("GetProcessTimes", w.BOOL, w.HANDLE,
                         *([c.POINTER(w.FILETIME)] * 4))
    wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    close = bind("CloseHandle", w.BOOL, w.HANDLE)
    observations = []
    for pid in pids:
        if not isinstance(pid, int) or pid <= 0:
            raise ValueError("Expected a positive process id")
        # QUERY_LIMITED_INFORMATION reads birth; SYNCHRONIZE proves termination.
        handle = open_process(0x1000 | 0x100000, False, pid)
        if not handle:
            error = c.get_last_error()
            if error != 87:  # ERROR_INVALID_PARAMETER: the positive PID is absent.
                raise c.WinError(error)
            observations.append(dict(pid=pid, alive=False, creationTime=None))
            continue
        try:
            result = wait(handle, 0)
            if result not in (0, 258):  # WAIT_OBJECT_0 / WAIT_TIMEOUT.
                raise c.WinError(c.get_last_error())
            times = [w.FILETIME() for _ in range(4)]
            if not process_times(handle, *(c.byref(value) for value in times)):
                raise c.WinError(c.get_last_error())
            creation = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
            observations.append(dict(pid=pid, alive=result == 258, creationTime=str(creation)))
        finally:
            if not close(handle):
                raise c.WinError(c.get_last_error())
    return observations


if __name__ == "__main__":
    print(json.dumps(dict(ready=True)), flush=True)
    # EOF retires the sampler even if its Node supervisor was killed.
    for line in sys.stdin:
        request = json.loads(line)
        print(json.dumps(dict(id=request["id"],
                              observations=read_processes(request["pids"]))), flush=True)
