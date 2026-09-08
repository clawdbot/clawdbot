#!/usr/bin/env python3
"""Run Parallels smoke commands with the verified 27.0.0 guest-exec ABI.

Usage: parallels-exec.py [--timeout-ms N] -- exec VM [--current-user] COMMAND...
Like prlctl, COMMAND arguments are joined with spaces; callers own shell quoting,
including when passing one already-quoted shell command. Stdin is guest data.
Other hosts/binaries use ordinary prlctl, selected before any guest execution.
This is a bounded installed-binary workaround, not a supported public SDK client.
"""
from __future__ import annotations

import argparse
import ctypes as C
from contextlib import ExitStack
import hashlib
import math
import os
from pathlib import Path
import platform
import shutil
import sys
import time

APP = Path("/Applications/Parallels Desktop.app/Contents")
# This digest identifies the verified 27.0.0 CLI and its installed SDK ABI.
CLI_HASH = "759030a682c31ae71878ab71f1bf1560957ff89308c9de621d1b9bee4b9fcd80"
DEFAULT_TIMEOUT_MS = 1_800_000
MAX_TIMEOUT_MS = (1 << 31) - 1
CLEANUP_TIMEOUT_MS = 5_000
# Public session selectors, not credentials; host/VM ownership still applies.
PRIVILEGED = b"531582ac-3dce-446f-8c26-dd7e3384dcf4"
CURRENT_USER = b"4a5533a7-31c6-4d7a-a400-1f330dc57a9d"
# PrlCommandsFlags.h: PACF_MAX=10, UUID=1<<(10+1), NAME=1<<(10+2).
# GetVmConfig searches UUID first, then name when both flags are supplied.
VM_SEARCH_FLAGS = (1 << 11) | (1 << 12)
H, R, U, S, I = C.c_void_p, C.c_int, C.c_uint32, C.c_char_p, C.c_int
HP = C.POINTER(H)


def checked(code: int | None, operation: str) -> None:
    if code:
        raise RuntimeError(f"{operation}: SDK error 0x{code & 0xffffffff:08x}")


def uses_verified_sdk() -> bool:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return False
    selected = shutil.which("prlctl")
    if selected is None:
        return False
    try:
        # Honor PATH-selected fakes/custom installs. The standard prlctl symlink
        # resolves to this bundle's parallels_wrapper, not its native CLI binary.
        if Path(selected).resolve(strict=True) not in {
            APP / "MacOS/prlctl",
            APP / "MacOS/parallels_wrapper",
        }:
            return False
        digest = hashlib.sha256((APP / "MacOS/prlctl").read_bytes()).hexdigest()
    except OSError:
        return False
    return digest == CLI_HASH


class GuestSdk:
    def __init__(self, deadline: float):
        library = APP / "Frameworks/ParallelsVirtualizationSDK.framework/Versions/11/libprl_sdk.11.dylib"
        self.api = C.CDLL(str(library))
        self.deadline = deadline
        self.resources = ExitStack()
        self.cleanup_error: Exception | None = None
        self.exit_code: int | None = None
        signatures = {
            "PrlApi_InitEx": (R, [U, I, U, U]),
            "PrlApi_Deinit": (R, []),
            "PrlHandle_Free": (R, [H]),
            "PrlSrv_Create": (R, [HP]),
            "PrlLoginParams_Create": (R, [HP]),
            "PrlLoginParams_SetFlags": (R, [H, U]),
            "PrlSrv_LoginLocalWithParams": (H, [H, H]),
            "PrlSrv_Logoff": (H, [H]),
            "PrlSrv_GetVmConfig": (H, [H, S, U]),
            "PrlVm_TerminalConnect": (H, [H, U]),
            "PrlVm_TerminalDisconnect": (R, [H]),
            "PrlVm_LoginInGuest": (H, [H, S, S, U]),
            "PrlVmGuest_Logout": (H, [H, U]),
            "PrlApi_CreateStringsList": (R, [HP]),
            "PrlVmGuest_RunProgram": (H, [H, S, H, H, U, I, I, I]),
            "PrlJob_Wait": (R, [H, U]),
            "PrlJob_GetRetCode": (R, [H, C.POINTER(R)]),
            "PrlJob_GetResult": (R, [H, HP]),
            "PrlResult_GetParam": (R, [H, HP]),
            "PrlJob_GetEvent": (R, [H, HP]),
            # Verified binary ABI uses an integer event-parameter identifier.
            "PrlEvent_GetParamByName": (R, [H, U, HP]),
            "PrlEvtPrm_ToUint32": (R, [H, C.POINTER(U)]),
        }
        for name, (result_type, argument_types) in signatures.items():
            function = getattr(self.api, name)
            function.restype = result_type
            function.argtypes = argument_types

    def __enter__(self):
        checked(self.api.PrlApi_InitEx(0xb0000, 0, 0, 0), "InitEx")
        self.resources.callback(self.cleanup, self.api.PrlApi_Deinit)
        return self

    def __exit__(self, exc_type, exc, traceback):
        # Cleanup gets one bounded reserve even after the command budget expires.
        # The host process watchdog remains the outer hard cap.
        self.deadline = time.monotonic() + CLEANUP_TIMEOUT_MS / 1000
        self.resources.close()
        if self.cleanup_error is not None:
            if exc_type is not None or self.exit_code not in (None, 0):
                print(f"[parallels-exec] cleanup failed: {self.cleanup_error}", file=sys.stderr)
            else:
                raise self.cleanup_error
        return False

    def cleanup(self, function, *args):
        try:
            checked(function(*args), function.__name__)
        except Exception as error:
            # All remaining releases must run, without replacing the primary error.
            if self.cleanup_error is None:
                self.cleanup_error = error

    def own(self, handle):
        if not handle:
            raise RuntimeError("SDK returned an invalid handle")
        self.resources.callback(self.cleanup, self.api.PrlHandle_Free, handle)
        return handle

    def output(self, function, *args):
        handle = H()
        checked(function(*args, C.byref(handle)), function.__name__)
        return self.own(handle.value)

    def remaining_timeout_ms(self):
        remaining_ms = math.ceil((self.deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            raise TimeoutError("SDK command budget exhausted")
        return min(remaining_ms, MAX_TIMEOUT_MS)

    def wait(self, job):
        checked(self.api.PrlJob_Wait(job, self.remaining_timeout_ms()), "PrlJob_Wait")
        result = R()
        checked(self.api.PrlJob_GetRetCode(job, C.byref(result)), "PrlJob_GetRetCode")
        checked(result.value, "job operation")

    def finish(self, job):
        self.wait(self.own(job))

    def result(self, job):
        # Retain the job through completion and result extraction. Releasing it
        # before Wait/GetRetCode is the affected CLI's ownership defect.
        self.finish(job)
        result = self.output(self.api.PrlJob_GetResult, job)
        return self.output(self.api.PrlResult_GetParam, result)

    def cleanup_job(self, function, *args):
        job = function(*args)
        if not job:
            raise RuntimeError("SDK returned an invalid cleanup job")
        try:
            self.wait(job)
        finally:
            checked(self.api.PrlHandle_Free(job), "PrlHandle_Free")

    def connect(self, vm_name: str):
        server = self.output(self.api.PrlSrv_Create)
        login = self.output(self.api.PrlLoginParams_Create)
        checked(self.api.PrlLoginParams_SetFlags(login, 4), "LoginParams_SetFlags")
        self.finish(self.api.PrlSrv_LoginLocalWithParams(server, login))
        self.resources.callback(self.cleanup, self.cleanup_job, self.api.PrlSrv_Logoff, server)
        vm = self.result(self.api.PrlSrv_GetVmConfig(server, vm_name.encode(), VM_SEARCH_FLAGS))
        self.finish(self.api.PrlVm_TerminalConnect(vm, 0))
        self.resources.callback(self.cleanup, self.api.PrlVm_TerminalDisconnect, vm)
        return vm

    def login_guest(self, vm, current_user: bool):
        selector = CURRENT_USER if current_user else PRIVILEGED
        guest = self.result(self.api.PrlVm_LoginInGuest(vm, selector, None, 0))
        self.resources.callback(self.cleanup, self.cleanup_job, self.api.PrlVmGuest_Logout, guest, 0)
        return guest

    def run(self, guest, command: str, current_user: bool):
        args = self.output(self.api.PrlApi_CreateStringsList)
        env = self.output(self.api.PrlApi_CreateStringsList)
        # Preserve the verified CLI shell/streaming flags and untouched stdin.
        flags = 0xb808 | (0x20000 if current_user else 0)
        self.remaining_timeout_ms()
        job = self.api.PrlVmGuest_RunProgram(guest, command.encode(), args, env, flags, 0, 1, 2)
        self.finish(job)
        event = self.output(self.api.PrlJob_GetEvent, job)
        parameter = self.output(self.api.PrlEvent_GetParamByName, event, 0x13e)
        exit_code = U()
        checked(self.api.PrlEvtPrm_ToUint32(parameter, C.byref(exit_code)), "exit code")
        self.exit_code = exit_code.value
        return self.exit_code


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        # Unsupported auth input may contain credentials; do not echo argv.
        raise ValueError("invalid wrapper arguments; use --timeout-ms N -- exec VM COMMAND...")


def main() -> int:
    try:
        parser = Arguments(description=__doc__)
        parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
        parser.add_argument("prlctl_args", nargs=argparse.REMAINDER)
        options = parser.parse_args()
        if not 1 <= options.timeout_ms <= MAX_TIMEOUT_MS:
            raise ValueError(f"timeout-ms must be between 1 and {MAX_TIMEOUT_MS}")
        argv = options.prlctl_args
        if argv[:1] == ["--"]:
            argv = argv[1:]
        deadline = time.monotonic() + options.timeout_ms / 1000
        if not uses_verified_sdk():
            os.execvp("prlctl", ["prlctl", *argv])
        if len(argv) < 3 or argv[0] != "exec":
            raise ValueError("SDK route supports only exec VM [--current-user] COMMAND...")
        vm_name, command_args = argv[1], argv[2:]
        if not vm_name or vm_name.startswith("-"):
            raise ValueError("SDK route requires a VM name or UUID before command options")
        current_user = command_args[:1] == ["--current-user"]
        if current_user:
            command_args = command_args[1:]
        if not command_args or command_args[0].startswith("-"):
            raise ValueError("SDK route requires a command; only --current-user is supported")
        with GuestSdk(deadline) as sdk:
            vm = sdk.connect(vm_name)
            guest = sdk.login_guest(vm, current_user)
            return sdk.run(guest, " ".join(command_args), current_user)
    except KeyboardInterrupt:
        print("[parallels-exec] interrupted", file=sys.stderr)
        code = 130
    except Exception as error:
        print(f"[parallels-exec] {error}", file=sys.stderr)
        code = 125
    print(f"[parallels-exec] FAILED (exit {code})", file=sys.stderr)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
