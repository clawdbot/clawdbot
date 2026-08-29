import os
import re
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import time

linux = os.environ.get("RUNNER_OS", sys.platform) in ("Linux", "linux")
fetch_timeout_seconds = 120 if linux else 90
cancelled = 0
closed = False
git = shutil.which("git")


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

    if (c.sizeof(BasicLimits), c.sizeof(ExtendedLimits), c.sizeof(Accounting), Accounting.ActiveProcesses.offset) != (64, 144, 48, 40):
        raise RuntimeError("Unsupported Windows Job structure layout")

    create_job = bind("CreateJobObjectW", w.HANDLE, c.c_void_p, w.LPCWSTR)
    set_job = bind("SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
    query_job = bind("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p)
    terminate_job = bind("TerminateJobObject", w.BOOL, w.HANDLE, w.UINT)
    bootstrap = windows_api + '''
job = int(sys.argv[1])
assign = bind("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
current = bind("GetCurrentProcess", w.HANDLE)
assign(job, current())
close_handle(job)
sys.exit(subprocess.call(sys.argv[2:], stdin=subprocess.DEVNULL))
'''


def group_signal(pgid, signum, deadline):
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Darwin can report EPERM for a zombie-only group. Only a checked
        # census proving no live members can authorize continuing.
        if group_alive(pgid, deadline):
            raise
        return False
    return True


def group_alive(pgid, deadline):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass  # EPERM can mean zombie-only; the census must still prove extinction.
    # Zombies are terminated, not writers. A failed/ambiguous inspection
    # never authorizes checkout reuse, including after a denied signal probe.
    result = subprocess.run(
        ["ps", "-axo", "pgid=,stat="], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, text=True, check=True,
        timeout=max(0.001, deadline - time.monotonic()),
    )
    return any(int(group) == pgid and not state.startswith("Z")
               for group, state in (line.split() for line in result.stdout.splitlines()))


def drain(child, job, cleanup_seconds):
    deadline = time.monotonic() + cleanup_seconds
    if os.name == "nt":
        # Stop/join even a pre-assignment bootstrap before terminating the Job:
        # an empty Job alone cannot prove that no Git will start afterwards.
        child.kill()
        child.wait(timeout=max(0.001, deadline - time.monotonic()))
        terminate_job(job, 1)
        accounting = Accounting()
        while True:
            query_job(job, 1, c.byref(accounting), c.sizeof(accounting), None)
            if accounting.ActiveProcesses == 0:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("Job cleanup did not complete")
            time.sleep(0.05)
    else:
        # The group remains ours after leader exit. Reserve half the existing
        # cleanup allowance for KILL and extinction verification after TERM.
        try:
            group_signal(child.pid, signal.SIGTERM, deadline)
            kill_at = deadline - cleanup_seconds / 2
            while True:
                child.poll()
                if not group_alive(child.pid, deadline):
                    child.wait(timeout=max(0.001, deadline - time.monotonic()))
                    return
                if time.monotonic() >= kill_at:
                    group_signal(child.pid, signal.SIGKILL, deadline)
                if time.monotonic() >= deadline:
                    raise RuntimeError("Process group cleanup did not complete")
                time.sleep(0.05)
        except Exception:
            group_signal(child.pid, signal.SIGKILL, deadline)
            # KILL queues termination; a leader wait cannot join descendants.
            # Count zombies conservatively here, but never reset the allowance or retry.
            while time.monotonic() < deadline:
                child.poll()
                if not group_signal(child.pid, 0, deadline):
                    break
                time.sleep(0.05)
            child.wait(timeout=max(0.001, deadline - time.monotonic()))
            raise


class FetchTimeout(Exception):
    pass


class GitFailure(Exception):
    def __init__(self, code):
        self.code = code


def run_git(directory, *arguments, timeout=None, stdout=None, stderr=None, env=None,
            cleanup_seconds=10):
    global closed
    if closed:
        raise RuntimeError("Git owner is closed")
    check_cancelled()
    if git is None:
        raise RuntimeError("Git unavailable")
    command = [git, "-C", directory, *arguments]
    job = None
    child = None
    deadline = time.monotonic() + timeout if timeout is not None else None
    try:
        options = {"stdin": subprocess.DEVNULL, "stdout": stdout, "stderr": stderr,
                   "env": {**os.environ, **env} if env is not None else None}
        if os.name == "nt":
            job = create_job(None, None)
            limits = ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway.
            set_job(job, 9, c.byref(limits), c.sizeof(limits))
            os.set_handle_inheritable(job, True)
            startup = subprocess.STARTUPINFO()
            startup.lpAttributeList = {"handle_list": [job]}
            options.update(startupinfo=startup, close_fds=True)
            # The selected checkout must not inject Python startup code into its owner.
            command = [sys.executable, "-I", "-S", "-c", bootstrap, str(job), *command]
        else:
            options["start_new_session"] = True
        # Signal handlers only latch cancellation, so Popen cannot lose ownership
        # between process creation and saving its handle/group for cleanup.
        child = subprocess.Popen(command, **options)
        if job is not None:
            os.set_handle_inheritable(job, False)
        while child.poll() is None and not cancelled:
            if deadline is not None and time.monotonic() >= deadline:
                raise FetchTimeout()
            time.sleep(0.05)
    finally:
        # Failed inspection/cleanup permanently fences this policy process. Only
        # verified extinction permits another command, even after a caught error.
        closed = True
        try:
            if child is not None:
                drain(child, job, cleanup_seconds)
        finally:
            if job is not None:
                close_handle(job)
        closed = False
        # Run even while a timeout is unwinding: cancellation received during
        # draining outranks it, but failed cleanup above still outranks both.
        check_cancelled()
    if child.returncode:
        raise GitFailure(child.returncode if child.returncode > 0 else 128 - child.returncode)


def backoff(seconds):
    retry_at = time.monotonic() + seconds
    while time.monotonic() < retry_at:
        check_cancelled()
        time.sleep(0.05)


def fetch(directory, *refs, prune=False, max_attempts=3, depth=1,
          blobless=False, retry_failures=False, retry_codes=()):
    for attempt in range(1, max_attempts + 1):
        try:
            run_git(directory, "-c", "protocol.version=2", "fetch", "--no-tags",
                    *(["--prune"] if prune else []), "--no-recurse-submodules", f"--depth={depth}",
                    *(["--filter=blob:none"] if blobless else []), "origin", *refs,
                    timeout=fetch_timeout_seconds)
            return
        except (FetchTimeout, GitFailure) as error:
            check_cancelled()
            retryable = isinstance(error, FetchTimeout) or retry_failures or error.code in retry_codes
            if not retryable or attempt == max_attempts:
                raise
            print(f"::warning::checkout fetch failed on attempt {attempt}; retrying", flush=True)
            backoff(5)


def git_output(directory, *arguments, timeout=None, env=None):
    with tempfile.TemporaryFile() as output:
        run_git(directory, *arguments, timeout=timeout, env=env, stdout=output)
        output.seek(0)
        return output.read().decode("utf-8", errors="surrogateescape")


def resolve_ref(ref):
    return git_output(workspace, "rev-parse", ref).strip()


def checkout_selected_ref():
    ref = os.environ["CHECKOUT_REF"]
    fallback = os.environ["CHECKOUT_FALLBACK_REF"]
    manual = os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch"
    requested = ref if kind == "preflight" and re.fullmatch("[0-9a-f]{40}", ref) else None
    # Prefer the event ref for an exact manual SHA, but detect a ref that moved in the queue.
    if requested and manual and ref == fallback and os.environ.get("CHECKOUT_EVENT_REF"):
        ref = os.environ["CHECKOUT_EVENT_REF"]

    def fetch_ref(value):
        fetch(workspace, f"+{value}:refs/remotes/origin/checkout", prune=True,
              depth=1 if kind == "preflight" else 2, retry_codes=(124, 137))

    try:
        fetch_ref(ref)
    except GitFailure as error:
        if error.code in (124, 137) or not manual or os.environ["CHECKOUT_REF"] == fallback:
            raise
        print("::warning::workflow_dispatch target_ref is unavailable; falling back to head SHA", flush=True)
        fetch_ref(fallback)
    if requested:
        resolved = resolve_ref("refs/remotes/origin/checkout")
        if resolved != requested and ref != requested:
            print("::notice::checkout ref moved; fetching requested SHA", flush=True)
            fetch_ref(requested)
            resolved = resolve_ref("refs/remotes/origin/checkout")
        if resolved != requested:
            print("::error::checkout ref did not resolve to the requested SHA", file=sys.stderr)
            raise GitFailure(1)
    if kind == "preflight":
        # Diff-base callers need parent commits/trees, not their blobs.
        try:
            fetch(workspace, resolve_ref("refs/remotes/origin/checkout"), prune=True,
                  depth=2, blobless=True, retry_failures=True)
        except (FetchTimeout, GitFailure):
            raise GitFailure(1)
    run_git(workspace, "checkout", "--detach", "refs/remotes/origin/checkout")


def checkout():
    check_cancelled()
    if reset:
        os.makedirs(workspace, exist_ok=True)
        # Every earlier Git group has been drained before deleting its workspace.
        subprocess.run(["find", workspace, "-mindepth", "1", "-maxdepth", "1",
                        "-exec", "rm", "-rf", "{}", "+"], check=True)
    run_git(workspace, "init", workspace)
    if kind in ("linux-node", "android"):
        run_git(workspace, "config", "--global", "--add", "safe.directory", workspace)
    run_git(workspace, "config", "gc.auto", "0")
    run_git(workspace, "remote", "add", "origin", remote)
    if kind in ("preflight", "manual"):
        checkout_selected_ref()
        return
    target = "refs/remotes/origin/ci-target" if kind in ("linux-node", "android") else "refs/remotes/origin/checkout"
    sha = "refs/heads/main" if kind == "clawhub" else os.environ["CHECKOUT_SHA"]
    refs = [f"+{sha}:{target}"]
    base = os.environ.get("CHECKOUT_BASE_SHA") if kind == "linux-node" else None
    if base:
        refs.append(f"+{base}:refs/remotes/origin/ci-ratchet-base")
    fetch(workspace, *refs, prune=True, max_attempts=1 if reset else 3,
          retry_codes=(124, 137) if kind == "skills" else ())
    run_git(workspace, "checkout", *(["--force"] if reset else []), "--detach",
            sha if kind in ("linux-node", "android") else target)
    if kind == "android":
        if not os.access(os.path.join(workspace, "apps/android/gradlew"), os.X_OK):
            raise GitFailure(1)
        return
    if kind in ("clawhub", "skills"):
        return
    action = ".github/actions/setup-node-env/action.yml"
    if kind == "linux-node" and not os.path.isfile(os.path.join(workspace, action)):
        raise GitFailure(1)
    harness = os.path.join(workspace, ".ci-harness")
    os.makedirs(harness, exist_ok=True)
    run_git(harness, "init", harness)
    run_git(harness, "remote", "add", "origin", remote)
    fetch(harness, f"+{os.environ['WORKFLOW_SHA']}:refs/remotes/origin/ci-harness", max_attempts=1)
    run_git(harness, "sparse-checkout", "set", ".github/actions")
    run_git(harness, "checkout", "--force", "--detach", os.environ["WORKFLOW_SHA"])
    if not os.path.isfile(os.path.join(harness, action)):
        raise GitFailure(1)
    check_cancelled()


def main():
    global kind, workspace, remote, reset
    if len(sys.argv) > 1:
        if sys.argv[1] == "--policy":
            # The caller supplies trusted policy bytes; imports share this exact
            # owner and its terminal lifecycle state, never a second supervisor.
            sys.modules["ci_git_owner"] = sys.modules[__name__]
            try:
                if sys.argv[2] == "-":
                    exec(compile(sys.stdin.read(), "<git-policy>", "exec"), {"__name__": "__main__"})
                else:
                    runpy.run_path(sys.argv[2], run_name="__main__")
            finally:
                if closed:
                    raise RuntimeError("Git owner is closed")
                check_cancelled()
            return
        if sys.argv[1] != "--git":
            raise ValueError("Unknown Git owner command")
        run_git(os.getcwd(), *sys.argv[3:], timeout=float(sys.argv[2]) or None)
        return
    if git is None:
        raise RuntimeError("Git unavailable")
    kind = os.environ.get("CHECKOUT_KIND", "linux-node" if linux else "platform")
    if kind == "prepare":
        raise SystemExit(0)
    workspace = os.environ["GITHUB_WORKSPACE"]
    remote = f"https://github.com/{os.environ['CHECKOUT_REPO']}.git"
    if kind == "clawhub":
        workspace = os.path.join(workspace, "clawhub-source")
    reset = kind in ("linux-node", "android", "clawhub")
    label = "ClawHub checkout" if kind == "clawhub" else "checkout"
    started_at = time.monotonic()
    for attempt in range(1, 6 if reset else 2):
        try:
            checkout()
            if reset:
                print(f"{label} attempt {attempt}/5 succeeded", flush=True)
            if kind == "clawhub":
                print(f"{label} completed in {int(time.monotonic() - started_at)}s", flush=True)
            raise SystemExit(0)
        except (FetchTimeout, GitFailure) as error:
            # Only command failures are retryable. Ownership/inspection errors
            # escape to the fail-closed boundary below, never workspace deletion.
            check_cancelled()
            if not reset:
                raise SystemExit(124 if isinstance(error, FetchTimeout) else error.code)
            print(f"{label} attempt {attempt}/5 failed", flush=True)
            backoff(attempt * 5)
    print(f"{label} failed after 5 attempts", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except FetchTimeout:
        raise SystemExit(124)
    except GitFailure as error:
        raise SystemExit(error.code)
    except Exception as error:
        # Do not print command arguments or environment: Git may carry credentials.
        print(f"::error::Git ownership/setup failed ({type(error).__name__}); refusing reuse or retry", file=sys.stderr)
        raise SystemExit(125)
