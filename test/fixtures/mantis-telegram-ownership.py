"""Linux-only synthetic proof of canonical recorder ownership and send deadlines."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
import tempfile
import time

source = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("driver", source / "user-driver.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
client = driver.TdClient.__new__(driver.TdClient)
client.deadline_unix_ms = time.time() * 1000 + 100
client.deadline_monotonic = time.monotonic() + 0.1
client.extra, client.pending, client.client = 0, {}, None
class NativeBoundary:
    calls = 0
    def td_json_client_send(self, *args):
        self.calls += 1
client.lib = NativeBoundary()
client.send({"@type": "getMe"})
assert client.lib.calls == 1

with tempfile.TemporaryDirectory(prefix="mantis-authority-") as root:
    authority = Path(root) / "deadline"
    authority.write_text(str(int(time.time() * 1000) - 1))
    client.deadline_unix_ms = time.time() * 1000 + 10000
    client.deadline_monotonic = time.monotonic() + 10
    client.proof_authority_file = str(authority)
    client.proof_clock_wall = time.time() * 1000
    client.proof_clock_monotonic = time.monotonic()
    try:
        client.send({"@type": "sendMessage"})
        raise AssertionError("revoked review reached native boundary")
    except driver.DriverError:
        pass
    assert client.lib.calls == 1
    client.proof_authority_file = None

paused_pid = os.fork()
if paused_pid == 0:
    client.deadline_unix_ms = time.time() * 1000 + 100
    client.deadline_monotonic = time.monotonic() + 0.1
    os.kill(os.getpid(), signal.SIGSTOP)
    try:
        client.send({"@type": "sendMessage"})
    except driver.DriverError:
        os._exit(0)
    os._exit(1)
os.waitpid(paused_pid, os.WUNTRACED)
time.sleep(0.15)
os.kill(paused_pid, signal.SIGCONT)
assert os.waitstatus_to_exitcode(os.waitpid(paused_pid, 0)[1]) == 0
# The action boundary itself must reject before a delayed timer can execute.
client.deadline_unix_ms = time.time() * 1000 + 100
client.deadline_monotonic = time.monotonic() + 0.1
time.sleep(0.15)
try:
    client.send({"@type": "sendMessage"})
    raise AssertionError("expired send reached native boundary")
except driver.DriverError:
    pass
assert client.lib.calls == 1

child = r'''
import importlib.util, os, sys, tempfile, threading, time
from pathlib import Path
filename = sys.argv[1]
spec = importlib.util.spec_from_file_location("recorder", sys.argv[1])
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)
def blocked_driver(deadline):
    threading.Thread(target=lambda: time.sleep(60), daemon=True).start()
    print(os.getpid(), flush=True)
    time.sleep(60)
    raise AssertionError("owner death failed to stop recorder")
if filename.endswith("user-driver.py"):
    with tempfile.TemporaryDirectory() as root:
        authority = Path(root) / "deadline"
        authority.write_text(str(int(time.time()*1000)+30000))
        os.environ["TELEGRAM_PROOF_AUTHORITY_FILE"] = str(authority)
        os.environ["TELEGRAM_PROOF_PARENT_PID"] = str(os.getppid())
        recorder.load_config = lambda: ({}, {})
        recorder.find_tdjson = blocked_driver
        sys.argv = [filename, "status", "--json"]
        recorder.main()
else:
    recorder.build_driver = blocked_driver
    sys.argv = [filename, "--proof-parent-pid", str(os.getppid()),
                "--proof-deadline-unix-ms", str(int(time.time()*1000)+30000)]
    recorder.main()
'''
parent = r'''
import subprocess, sys, time
subprocess.Popen([sys.executable, "-c", sys.argv[1], sys.argv[2]])
time.sleep(60)
'''
for filename in ["user-record.py", "user-driver.py"]:
    owner = subprocess.Popen([sys.executable, "-c", parent, child, str(source / filename)],
                             stdout=subprocess.PIPE, text=True)
    child_pid = None
    try:
        ready, _, _ = select.select([owner.stdout], [], [], 5)
        assert ready, f"{filename} did not reach the controlled native boundary"
        child_pid = int(owner.stdout.readline().strip())
        os.kill(owner.pid, signal.SIGKILL)
        owner.wait(timeout=3)
        for _ in range(100):
            state = Path(f"/proc/{child_pid}/stat")
            try:
                stopped = state.read_text().split()[2] == "Z"
            except FileNotFoundError:
                stopped = True
            if stopped:
                break
            time.sleep(0.02)
        else:
            raise AssertionError(f"{filename} survived owner SIGKILL")
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait()
        if child_pid:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

status_expired = r'''
import importlib.util, os, sys, tempfile, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("driver", sys.argv[1])
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
with tempfile.TemporaryDirectory() as root:
    authority = Path(root) / "deadline"
    authority.write_text(str(int(time.time()*1000)-1))
    os.environ["TELEGRAM_PROOF_AUTHORITY_FILE"] = str(authority)
    os.environ["TELEGRAM_PROOF_PARENT_PID"] = str(os.getppid())
    driver.load_config = lambda: ({}, {})
    def unexpected_native(config):
        raise AssertionError("expired status reached native setup")
    driver.find_tdjson = unexpected_native
    try:
        driver.command_status(type("Args", (), {"json":True,"timeout_ms":1000})())
    except driver.DriverError:
        sys.exit(0)
    raise AssertionError("expired status was not refused")
'''
subprocess.run([sys.executable, "-c", status_expired, str(source / "user-driver.py")], check=True, timeout=5)
print(json.dumps({"deadline_native_sends": client.lib.calls, "paused_resume": "stale_send_refused", "parent_death": "recorder_and_status_stopped", "expired_status": "refused_before_native_setup",
                  "limits": "Synthetic native boundary; no Telegram traffic or TDLib background-traffic claim"}))
