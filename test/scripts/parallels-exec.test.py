"""Deterministic installed-ABI boundary tests; never load Parallels or contact a VM."""
from __future__ import annotations

from contextlib import ExitStack, redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

CLIENT_PATH = Path(__file__).resolve().parents[2] / "scripts/e2e/parallels/parallels-exec.py"
spec = importlib.util.spec_from_file_location("parallels_exec", CLIENT_PATH)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

# Independent constants from the verified installation and official SDK docs.
VERIFIED_HASH = "759030a682c31ae71878ab71f1bf1560957ff89308c9de621d1b9bee4b9fcd80"
PRIVILEGED = b"531582ac-3dce-446f-8c26-dd7e3384dcf4"
CURRENT_USER = b"4a5533a7-31c6-4d7a-a400-1f330dc57a9d"


class ExecReplaced(BaseException):
    """A successful execvp replaces the process rather than returning."""


class FakeSdk:
    """Enforce live-handle ownership at the external C API boundary."""

    def __init__(self, exit_code=0, failure=None, stream=False):
        self.exit_code = exit_code
        self.failure = failure
        self.stream = stream
        self.now = 100.0
        self.handles = {}
        self.freed = []
        self.events = []
        self.functions = {}
        self.next_handle = 1
        self.initialized = False

    def __getattr__(self, name):
        if not name.startswith("Prl"):
            raise AttributeError(name)
        if name not in self.functions:
            function = Mock(side_effect=lambda *args: self.call(name, args))
            function.__name__ = name
            self.functions[name] = function
        return self.functions[name]

    def create(self, kind, operation=None):
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = {"kind": kind, "operation": operation, "waited": False}
        return handle

    def live(self, handle, kind=None):
        assert handle in self.handles, f"unowned handle {handle}"
        assert handle not in self.freed, f"released handle {handle}"
        value = self.handles[handle]
        if kind is not None:
            assert value["kind"] == kind, (value, kind)
        return value

    def output(self, pointer, kind, operation=None):
        pointer._obj.value = self.create(kind, operation)
        return 0

    def completed(self, handle):
        job = self.live(handle, "job")
        assert job["waited"], "job queried before successful wait"
        return job["operation"]

    def call(self, name, args):
        self.events.append((name, args))
        if name == "PrlApi_InitEx":
            if self.failure == "init":
                return 1
            self.initialized = True
            return 0
        assert self.initialized, "API used outside initialized lifetime"
        if name == "PrlApi_Deinit":
            assert set(self.freed) == set(self.handles), "handles leaked at deinit"
            self.initialized = False
            return 0
        if name == "PrlHandle_Free":
            self.live(args[0])
            self.freed.append(args[0])
            return 0
        if name == "PrlSrv_Create":
            return self.output(args[0], "server")
        if name == "PrlLoginParams_Create":
            return self.output(args[0], "login")
        if name == "PrlLoginParams_SetFlags":
            self.live(args[0], "login")
            assert args[1] == 4
            return 0
        if name == "PrlSrv_LoginLocalWithParams":
            self.live(args[0], "server")
            self.live(args[1], "login")
            return self.create("job", "host-login")
        if name == "PrlSrv_GetVmConfig":
            self.live(args[0], "server")
            assert args[2] == 0x1800, "must search UUID then name"
            return self.create("job", "vm")
        if name == "PrlVm_TerminalConnect":
            self.live(args[0], "vm")
            return self.create("job", "terminal")
        if name == "PrlVm_LoginInGuest":
            self.live(args[0], "vm")
            assert args[1] in (PRIVILEGED, CURRENT_USER)
            assert args[2:] == (None, 0)
            return self.create("job", "guest")
        if name == "PrlApi_CreateStringsList":
            return self.output(args[0], "strings")
        if name == "PrlVmGuest_RunProgram":
            self.live(args[0], "guest")
            self.live(args[2], "strings")
            self.live(args[3], "strings")
            assert args[4] in (0xb808, 0x2b808)
            assert args[5:] == (0, 1, 2)
            if self.stream:
                while chunk := os.read(args[5], 65536):
                    os.write(args[6], chunk)
                os.write(args[7], b"guest-stderr\n")
            return self.create("job", "run")
        if name == "PrlJob_Wait":
            job = self.live(args[0], "job")
            assert 1 <= args[1] <= (1 << 31) - 1
            self.now += 0.25
            if self.failure == "wait-" + job["operation"]:
                return 1
            job["waited"] = True
            return 0
        if name == "PrlJob_GetRetCode":
            operation = self.completed(args[0])
            args[1]._obj.value = int(self.failure == operation)
            return 0
        if name == "PrlJob_GetResult":
            operation = self.completed(args[0])
            if self.failure == "result-" + operation:
                return 1
            return self.output(args[1], "result", operation)
        if name == "PrlResult_GetParam":
            result = self.live(args[0], "result")
            if self.failure == "param-" + result["operation"]:
                return 1
            return self.output(args[1], result["operation"])
        if name == "PrlJob_GetEvent":
            assert self.completed(args[0]) == "run"
            return self.output(args[1], "event")
        if name == "PrlEvent_GetParamByName":
            self.live(args[0], "event")
            assert args[1] == 0x13e
            return self.output(args[2], "parameter")
        if name == "PrlEvtPrm_ToUint32":
            self.live(args[0], "parameter")
            args[1]._obj.value = self.exit_code
            return 0
        if name == "PrlVmGuest_Logout":
            self.live(args[0], "guest")
            return self.create("job", "logout")
        if name == "PrlVm_TerminalDisconnect":
            self.live(args[0], "vm")
            return int(self.failure == "disconnect")
        if name == "PrlSrv_Logoff":
            self.live(args[0], "server")
            return self.create("job", "logoff")
        raise AssertionError(f"unexpected SDK call {name}")

    def calls(self, name):
        return [args for event, args in self.events if event == name]

    def assert_released(self, test):
        test.assertEqual(len(self.freed), len(set(self.freed)))
        test.assertEqual(set(self.freed), set(self.handles))
        test.assertFalse(self.initialized)


def boundaries(
    fake, argv, system="Darwin", machine="arm64", digest=VERIFIED_HASH,
    selected="/usr/local/bin/prlctl",
    resolved="/Applications/Parallels Desktop.app/Contents/MacOS/parallels_wrapper",
):
    stack = ExitStack()
    stack.enter_context(patch.object(sys, "argv", [str(CLIENT_PATH), *argv]))
    stack.enter_context(patch.object(client.platform, "system", return_value=system))
    stack.enter_context(patch.object(client.platform, "machine", return_value=machine))
    stack.enter_context(patch.object(client.shutil, "which", return_value=selected))
    stack.enter_context(patch.object(Path, "resolve", return_value=Path(resolved)))
    stack.enter_context(patch.object(Path, "read_bytes", return_value=b"synthetic CLI"))
    stack.enter_context(patch.object(client.hashlib, "sha256", return_value=Mock(hexdigest=lambda: digest)))
    stack.enter_context(patch.object(client.C, "CDLL", return_value=fake))
    stack.enter_context(patch.object(client.time, "monotonic", side_effect=lambda: fake.now))
    stack.enter_context(patch.object(client.os, "execvp", side_effect=ExecReplaced))
    return stack


class ParallelsExecTests(unittest.TestCase):
    def invoke(self, fake, args=None):
        error = io.StringIO()
        with boundaries(fake, args or ["--", "exec", "Synthetic VM", "/bin/true"]):
            with redirect_stderr(error):
                code = client.main()
            client.os.execvp.assert_not_called()
        return code, error.getvalue()

    def test_retains_every_handle_through_its_last_use_and_releases_once(self):
        fake = FakeSdk()
        self.assertEqual(self.invoke(fake), (0, ""))
        fake.assert_released(self)
        names = [name for name, _ in fake.events]
        self.assertLess(names.index("PrlVmGuest_Logout"), names.index("PrlVm_TerminalDisconnect"))
        self.assertLess(names.index("PrlVm_TerminalDisconnect"), names.index("PrlSrv_Logoff"))
        self.assertEqual(names[-1], "PrlApi_Deinit")

    def test_root_current_user_and_name_uuid_lookup(self):
        for vm in ["Synthetic VM", "{11111111-2222-3333-4444-555555555555}"]:
            for current in [False, True]:
                with self.subTest(vm=vm, current=current):
                    fake = FakeSdk()
                    args = ["--", "exec", vm, *(["--current-user"] if current else []), "whoami"]
                    self.assertEqual(self.invoke(fake, args), (0, ""))
                    self.assertEqual(fake.calls("PrlSrv_GetVmConfig")[0][1:], (vm.encode(), 0x1800))
                    self.assertEqual(fake.calls("PrlVm_LoginInGuest")[0][1], CURRENT_USER if current else PRIVILEGED)
                    self.assertEqual(fake.calls("PrlVmGuest_RunProgram")[0][4], 0x2b808 if current else 0xb808)
                    fake.assert_released(self)

    def test_preserves_prlctl_raw_shell_argument_semantics(self):
        cases = [
            (["/bin/sh -c 'printf \"quoted value\"; exit 7'"], b"/bin/sh -c 'printf \"quoted value\"; exit 7'"),
            (["/bin/printf", "'%s\\n'", "'two words'", "''", "'$HOME;literal'", "'café'"], b"/bin/printf '%s\\n' 'two words' '' '$HOME;literal' 'caf\xc3\xa9'"),
            (["/bin/echo", "", "already\\ escaped"], b"/bin/echo  already\\ escaped"),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                fake = FakeSdk()
                self.assertEqual(self.invoke(fake, ["--", "exec", "VM", *args]), (0, ""))
                self.assertEqual(fake.calls("PrlVmGuest_RunProgram")[0][1], expected)

    def test_passes_binary_stdin_and_separate_output_exit_through_process(self):
        code = """import runpy, sys
fixture = runpy.run_path(sys.argv.pop(1))
fake = fixture['FakeSdk'](exit_code=7, stream=True)
with fixture['boundaries'](fake, ['--', 'exec', 'Synthetic VM', '/bin/cat']):
    raise SystemExit(fixture['client'].main())
"""
        payload = b"first line\n\x00\xfflast line\n"
        result = subprocess.run(
            [sys.executable, "-B", "-c", code, str(Path(__file__).resolve())],
            input=payload, capture_output=True, timeout=10, check=False,
        )
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, payload)
        self.assertEqual(result.stderr, b"guest-stderr\n")

    def test_unsupported_hosts_or_hash_exec_original_arguments_without_sdk(self):
        argv = ["exec", "VM with spaces", "--user", "synthetic-user", "/bin/sh -c 'echo ready'"]
        for system, machine, digest in [("Linux", "arm64", VERIFIED_HASH), ("Darwin", "x86_64", VERIFIED_HASH), ("Darwin", "arm64", "unrecognized")]:
            with self.subTest(system=system, machine=machine, digest=digest):
                fake = FakeSdk()
                with boundaries(fake, ["--timeout-ms", "1000", "--", *argv], system, machine, digest):
                    with self.assertRaises(ExecReplaced):
                        client.main()
                    client.os.execvp.assert_called_once_with("prlctl", ["prlctl", *argv])
                    client.C.CDLL.assert_not_called()
                self.assertEqual(fake.events, [])

    def test_custom_or_missing_path_selection_never_loads_default_bundle_sdk(self):
        argv = ["exec", "Synthetic VM", "--current-user", "/bin/sh -c 'echo ready'"]
        for selected, resolved in [
            ("/tmp/synthetic-bin/prlctl", "/tmp/synthetic-bin/prlctl"),
            ("/usr/local/bin/prlctl", "/opt/custom-parallels/prlctl"),
            (None, "/Applications/Parallels Desktop.app/Contents/MacOS/parallels_wrapper"),
        ]:
            with self.subTest(selected=selected, resolved=resolved):
                fake = FakeSdk()
                with boundaries(fake, ["--", *argv], selected=selected, resolved=resolved):
                    with self.assertRaises(ExecReplaced):
                        client.main()
                    client.os.execvp.assert_called_once_with("prlctl", ["prlctl", *argv])
                    client.C.CDLL.assert_not_called()
                    Path.read_bytes.assert_not_called()
                    if selected is None:
                        Path.resolve.assert_not_called()
                self.assertEqual(fake.events, [])

    def test_selected_default_cli_or_wrapper_can_use_verified_sdk(self):
        for executable in ["prlctl", "parallels_wrapper"]:
            with self.subTest(executable=executable):
                resolved = f"/Applications/Parallels Desktop.app/Contents/MacOS/{executable}"
                fake = FakeSdk()
                with boundaries(fake, ["--", "exec", "VM", "true"], resolved=resolved):
                    self.assertEqual(client.main(), 0)
                    client.shutil.which.assert_called_once_with("prlctl")
                    Path.resolve.assert_called_once_with(strict=True)
                    client.os.execvp.assert_not_called()
                fake.assert_released(self)

    def test_missing_cli_uses_prlctl_before_sdk(self):
        fake = FakeSdk()
        with boundaries(fake, ["--", "exec", "VM", "true"]):
            with patch.object(Path, "read_bytes", side_effect=FileNotFoundError):
                with self.assertRaises(ExecReplaced):
                    client.main()
                client.C.CDLL.assert_not_called()
                client.os.execvp.assert_called_once_with("prlctl", ["prlctl", "exec", "VM", "true"])

    def test_sdk_load_failure_never_falls_back(self):
        fake = FakeSdk()
        error = io.StringIO()
        with boundaries(fake, ["--", "exec", "VM", "true"]):
            with patch.object(client.C, "CDLL", side_effect=OSError("SDK unavailable")):
                with redirect_stderr(error):
                    self.assertEqual(client.main(), 125)
                client.os.execvp.assert_not_called()
        self.assertIn("SDK unavailable", error.getvalue())
        self.assertTrue(error.getvalue().endswith("[parallels-exec] FAILED (exit 125)\n"))

    def test_rejects_unsupported_auth_before_sdk_without_echoing_values(self):
        for argv in [
            ["exec", "VM", "--user", "synthetic-secret"],
            ["exec", "--user", "synthetic-secret", "true"],
            ["exec", "VM", "--current-user", "--password", "synthetic-secret"],
            ["exec", "VM", "--current-user"],
            ["start", "VM"],
        ]:
            with self.subTest(argv=argv):
                fake = FakeSdk()
                error = io.StringIO()
                with boundaries(fake, ["--", *argv]):
                    with redirect_stderr(error):
                        self.assertEqual(client.main(), 125)
                    client.C.CDLL.assert_not_called()
                    client.os.execvp.assert_not_called()
                self.assertNotIn("synthetic-secret", error.getvalue())
                self.assertTrue(error.getvalue().endswith("[parallels-exec] FAILED (exit 125)\n"))

    def test_partial_acquisition_failures_release_only_owned_resources(self):
        for failure in ["init", "host-login", "vm", "result-vm", "param-vm", "terminal", "guest", "result-guest", "param-guest"]:
            with self.subTest(failure=failure):
                fake = FakeSdk(failure=failure)
                self.assertEqual(self.invoke(fake)[0], 125)
                self.assertEqual(fake.calls("PrlVmGuest_RunProgram"), [])
                fake.assert_released(self)
                self.assertEqual(fake.calls("PrlVmGuest_Logout"), [])

    def test_command_error_or_wait_failure_never_replays(self):
        for failure in ["run", "wait-run"]:
            with self.subTest(failure=failure):
                fake = FakeSdk(failure=failure)
                code, error = self.invoke(fake)
                self.assertEqual(code, 125)
                self.assertIn("SDK error", error)
                self.assertEqual(len(fake.calls("PrlVmGuest_RunProgram")), 1)
                self.assertEqual(fake.calls("PrlJob_GetEvent"), [])
                fake.assert_released(self)

    def test_guest_nonzero_and_cleanup_failure_precedence(self):
        for exit_code in [0, 7]:
            for failure in [None, "logout", "disconnect", "logoff"]:
                with self.subTest(exit_code=exit_code, failure=failure):
                    fake = FakeSdk(exit_code=exit_code, failure=failure)
                    code, error = self.invoke(fake)
                    self.assertEqual(code, exit_code if exit_code or failure is None else 125)
                    if failure and exit_code:
                        self.assertIn("cleanup failed", error)
                        self.assertNotIn("FAILED (exit 125)", error)
                    elif failure:
                        self.assertTrue(error.endswith("[parallels-exec] FAILED (exit 125)\n"))
                    else:
                        self.assertEqual(error, "")
                    fake.assert_released(self)

    def test_original_sdk_error_survives_cleanup_failure(self):
        fake = FakeSdk(failure="run")
        original_call = fake.call

        def with_cleanup_failure(name, args):
            if name == "PrlVm_TerminalDisconnect":
                original_call(name, args)
                return 2
            return original_call(name, args)

        # Substitute behavior only in the external C API fake, not client methods.
        fake.call = with_cleanup_failure
        code, error = self.invoke(fake)
        self.assertEqual(code, 125)
        self.assertIn("cleanup failed: PrlVm_TerminalDisconnect: SDK error 0x00000002", error)
        self.assertIn("[parallels-exec] job operation: SDK error 0x00000001", error)
        fake.assert_released(self)

    def test_waits_share_monotonic_budget_and_cleanup_uses_bounded_reserve(self):
        fake = FakeSdk()
        self.assertEqual(self.invoke(fake), (0, ""))
        waits = fake.calls("PrlJob_Wait")
        command_waits = [timeout for handle, timeout in waits if fake.handles[handle]["operation"] not in ("logout", "logoff")]
        cleanup_waits = [timeout for handle, timeout in waits if fake.handles[handle]["operation"] in ("logout", "logoff")]
        self.assertEqual(command_waits, [1_800_000, 1_799_750, 1_799_500, 1_799_250, 1_799_000])
        self.assertEqual(cleanup_waits, [5000, 4750])

    def test_exhausted_budget_does_not_launch_command_and_still_cleans_up(self):
        fake = FakeSdk()
        code, error = self.invoke(fake, ["--timeout-ms", "1000", "--", "exec", "VM", "true"])
        self.assertEqual(code, 125)
        self.assertIn("budget exhausted", error)
        self.assertEqual(fake.calls("PrlVmGuest_RunProgram"), [])
        self.assertEqual(len(fake.calls("PrlVmGuest_Logout")), 1)
        fake.assert_released(self)

    def test_timeout_bounds_are_checked_before_side_effects(self):
        for timeout in ["0", "-1", "2147483648", "not-a-number"]:
            with self.subTest(timeout=timeout):
                fake = FakeSdk()
                self.assertEqual(self.invoke(fake, ["--timeout-ms", timeout, "--", "exec", "VM", "true"])[0], 125)
                self.assertEqual(fake.events, [])
        fake = FakeSdk()
        self.assertEqual(self.invoke(fake, ["--timeout-ms", "2147483647", "--", "exec", "VM", "true"]), (0, ""))
        self.assertEqual(fake.calls("PrlJob_Wait")[0][1], 2147483647)


if __name__ == "__main__":
    unittest.main()
