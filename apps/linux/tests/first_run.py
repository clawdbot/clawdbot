#!/usr/bin/env python3
"""Exercise the real CI development binary with isolated first-run state.

Run as a non-root user with python3-gi, gir1.2-atspi-2.0, at-spi2-core,
libatk-adaptor, xvfb, xauth and dbus-x11 installed:
  xvfb-run -a dbus-run-session -- python3 apps/linux/tests/first_run.py BINARY

Use the unbundled 0.1.0 development build: local setup on a release build
intentionally starts installation instead of showing the channel chooser.
--local-start-failure uses a fixture CLI to exercise failed local startup.
"""

import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


START_FAILURE = "Fixture: systemd user service is unavailable."


def exercise(app, Atspi, GLib, *, remote_only, local_start_failure):
    last_headings = set()

    def text_content(node):
        text = node.get_text_iface()
        if text is None:
            return None
        # Ubuntu 24's GI bindings dispatch text.get_text(...) back through
        # Accessible.get_text(). Calling the interface method is stable on both
        # the Ubuntu 22 and 24 AT-SPI API shapes.
        return Atspi.Text.get_text(text, 0, -1)

    def nodes():
        desktop = Atspi.get_desktop(0)
        for index in range(desktop.get_child_count()):
            owner = desktop.get_child_at_index(index)
            if owner is None or owner.get_process_id() != app.pid:
                continue
            pending = [owner]
            visited = 0
            while pending:
                node = pending.pop()
                # A child can disappear while WebKit builds or replaces its tree.
                if node is None:
                    continue
                visited += 1
                if visited > 500:
                    raise RuntimeError("First-run accessibility tree exceeded 500 nodes")
                yield node
                pending.extend(
                    node.get_child_at_index(child)
                    for child in range(node.get_child_count())
                )

    def wait(label, role=None, *, prefix=False, predicate=None):
        deadline = time.monotonic() + 30
        last_error = None
        while time.monotonic() < deadline:
            if app.poll() is not None:
                raise RuntimeError(f"Native app exited with {app.returncode} waiting for {label!r}")
            try:
                last_headings.clear()
                for node in nodes():
                    name = node.get_name()
                    # WebKitGTK 2.50.4 emits shifted numeric AT-SPI roles. Ask it
                    # for the role name instead; the child locale is C.UTF-8.
                    actual_role = node.get_localized_role_name()
                    if actual_role == "heading":
                        last_headings.add(name)
                    if role is None:
                        matches = text_content(node) == label
                    else:
                        matches = actual_role == role and (
                            name.startswith(label) if prefix else name == label
                        )
                    # Application-root state queries can block in GTK; only
                    # inspect visibility on the semantic control being asserted.
                    if (
                        matches
                        and node.get_state_set().contains(Atspi.StateType.VISIBLE)
                        and (predicate is None or predicate(node))
                    ):
                        print(f"Observed {label}", flush=True)
                        return node
                last_error = None
            except GLib.Error as error:
                # WebKit can replace accessible objects during a screen transition.
                last_error = error
            time.sleep(0.1)
        raise RuntimeError(
            f"Timed out waiting for {label!r}; headings={sorted(last_headings)!r}; "
            f"accessibility error={last_error}"
        )

    def click(label, role="push button", *, prefix=False):
        node = wait(label, role, prefix=prefix)
        action = node.get_action_iface()
        if action is None or action.get_n_actions() == 0 or not action.do_action(0):
            raise RuntimeError(f"Could not activate {label!r} through AT-SPI")

    def empty_entry(label):
        node = wait(label, "entry")
        if text_content(node):
            raise RuntimeError(f"Expected an empty {label!r}; refusing a remote connection")

    wait("Welcome to OpenClaw", "heading")
    if local_start_failure:
        for attempt in range(2):
            click("Get started")
            wait("Where should your assistant live?", "heading")
            click("On this computer", "toggle button", prefix=True)
            click("Continue")
            wait("OpenClaw needs attention", "heading")
            wait(START_FAILURE)
            wait("Try again", "push button")
            if attempt == 0:
                click("Try again")
                wait("Welcome to OpenClaw", "heading")
        calls = Path("cli-calls.log").read_text().splitlines()
        if calls.count("gateway install --json") != 2:
            raise RuntimeError(f"Expected two failed Gateway installs, observed {calls!r}")
        print("PASS: failed local startup reports its error and stays retryable", flush=True)
        return
    click("Get started")
    wait("Where should your assistant live?", "heading")
    click("On another computer", "toggle button", prefix=True)
    wait("Gateway URL", "toggle button")
    wait("SSH tunnel", "toggle button")
    empty_entry("Gateway URL")
    click("Connect to Gateway")
    wait("Enter a Gateway URL to continue.")
    click("SSH tunnel", "toggle button")
    empty_entry("SSH target")
    wait("Gateway port", "entry")
    click("Connect to Gateway")
    wait("Enter an SSH target to continue.")
    if remote_only:
        print("PASS: native first-run remote choices", flush=True)
        return
    click("Back")
    wait("Welcome to OpenClaw", "heading")
    click("Get started")
    click("On this computer", "toggle button", prefix=True)
    click("Continue")
    # Keeping missingCli (not unconfigured) is what preserves local installation.
    wait("Choose a release channel", "heading")
    click("RELEASE CHANNEL", "combo box")
    # WebKit exposes native options as menu items or table cells across distros.
    # Their visible text and selected state express the channel choice directly.
    wait(
        "Development",
        predicate=lambda node: node.get_state_set().contains(Atspi.StateType.SELECTED),
    )
    wait("Install OpenClaw", "push button")
    print("PASS: native first-run remote choices and local development channel", flush=True)


def interrupted(signum, _frame):
    raise RuntimeError(f"Native first-run smoke interrupted by signal {signum}")


def drive(binary, *, remote_only, local_start_failure, artifacts_dir):
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib
    except (ImportError, ValueError) as error:
        raise RuntimeError(f"Install python3-gi and gir1.2-atspi-2.0: {error}") from error

    Atspi.set_timeout(1000, 1000)
    desktop = Atspi.get_desktop(0)
    if desktop is None or desktop.get_child_count():
        raise RuntimeError("AT-SPI needs an empty private accessibility session")

    def capture(outcome):
        if artifacts_dir is None:
            return
        scenario = "local-start-failure" if local_start_failure else "choices"
        screenshot = artifacts_dir / f"{scenario}-{outcome}.png"
        started = time.monotonic()
        while True:
            subprocess.run(
                ["/usr/bin/import", "-window", "root", str(screenshot)],
                check=True, timeout=10,
            )
            colors = int(subprocess.check_output(
                ["/usr/bin/identify", "-format", "%k", str(screenshot)],
                text=True, timeout=10,
            ))
            elapsed = time.monotonic() - started
            # AT-SPI runs ahead of painting, including a stale first frame.
            # Allow one second to settle; black-root/blank-window frames have two colors.
            if elapsed >= 1 and colors > 2:
                print(f"Screenshot: {screenshot} (captured after {elapsed:.2f}s)", flush=True)
                return
            if elapsed >= 5:
                raise RuntimeError("Native window remained blank while capturing proof")
            time.sleep(0.1)

    with Path("app.log").open("wb") as log:
        app = subprocess.Popen(
            [str(binary)],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            exercise(
                app, Atspi, GLib,
                remote_only=remote_only,
                local_start_failure=local_start_failure,
            )
        except BaseException:
            try:
                capture("failed")
            except (OSError, subprocess.SubprocessError) as error:
                print(f"Could not capture failed native state: {error}", file=sys.stderr)
            raise
        else:
            capture("passed")
        finally:
            if app.poll() is None:
                app.terminate()
            try:
                app.wait(timeout=5)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait(timeout=5)
            Atspi.exit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--driver", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--artifacts-dir", type=Path,
        help="Retain a screenshot of the final native state (requires ImageMagick)",
    )
    scenarios = parser.add_mutually_exclusive_group()
    scenarios.add_argument(
        "--remote-only",
        action="store_true",
        help="Stop after validating release-safe remote setup choices",
    )
    scenarios.add_argument(
        "--local-start-failure",
        action="store_true",
        help="Verify failed startup with an installed CLI remains visible and retryable",
    )
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() == 0:
        parser.error("Run on Linux as a non-root user; do not disable the WebKit sandbox")
    for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS"):
        if not os.environ.get(key):
            parser.error("Run inside xvfb-run and a private dbus-run-session")
    binary = args.binary.resolve(strict=True)
    if not os.access(binary, os.X_OK):
        parser.error("The native app binary must be executable")
    if shutil.which("openclaw", path="/usr/bin:/bin"):
        parser.error("The minimal system PATH must not contain an OpenClaw CLI")
    if args.artifacts_dir:
        args.artifacts_dir = args.artifacts_dir.resolve()
        args.artifacts_dir.mkdir(parents=True, exist_ok=True)
        if not all(os.access(f"/usr/bin/{tool}", os.X_OK) for tool in ("import", "identify")):
            parser.error("Screenshot capture requires ImageMagick's import and identify")

    if args.driver:
        drive(
            binary,
            remote_only=args.remote_only,
            local_start_failure=args.local_start_failure,
            artifacts_dir=args.artifacts_dir,
        )
        return

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    with tempfile.TemporaryDirectory(prefix="openclaw-first-run-") as directory:
        root = Path(directory)
        # Allowlisting drops CLI/config overrides, credentials and existing desktop state.
        env = {
            key: os.environ[key]
            for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY")
            if key in os.environ
        }
        env.update(
            HOME=str(root),
            PATH="/usr/bin:/bin",
            LANG="C.UTF-8",
            LC_ALL="C.UTF-8",
            GDK_BACKEND="x11",
            XDG_SESSION_TYPE="x11",
            GTK_MODULES="atk-bridge",
            NO_AT_BRIDGE="0",
        )
        for variable, relative in (
            ("XDG_CONFIG_HOME", ".config"),
            ("XDG_CACHE_HOME", ".cache"),
            ("XDG_DATA_HOME", ".local/share"),
            ("XDG_STATE_HOME", ".local/state"),
            ("XDG_RUNTIME_DIR", "runtime"),
            ("TMPDIR", "tmp"),
        ):
            path = root / relative
            path.mkdir(mode=0o700, parents=True)
            env[variable] = str(path)
        if args.local_start_failure:
            cli = root / ".openclaw/bin/openclaw"
            cli.parent.mkdir(mode=0o700, parents=True)
            cli.write_text(
                "#!/usr/bin/python3\n"
                "import json, sys\n"
                "from pathlib import Path\n"
                "command = ' '.join(sys.argv[1:])\n"
                "with Path('cli-calls.log').open('a') as log: log.write(command + '\\n')\n"
                "if command == '--version':\n"
                "    print('OpenClaw fixture')\n"
                "elif command == 'gateway status --json':\n"
                "    print(json.dumps({'service': {'loaded': False}, 'rpc': {'ok': False}}))\n"
                "elif command == 'gateway install --json':\n"
                f"    print({START_FAILURE!r}, file=sys.stderr)\n"
                "    sys.exit(1)\n"
                "else:\n"
                "    raise RuntimeError('Unexpected CLI command: ' + command)\n"
            )
            cli.chmod(0o700)
        # Native AT-SPI calls can block Python signal handlers. Keep the deadline
        # and cleanup outside that process, with its app in the same owned group.
        command = [sys.executable, str(Path(__file__).resolve()), "--driver"]
        if args.remote_only:
            command.append("--remote-only")
        if args.local_start_failure:
            command.append("--local-start-failure")
        if args.artifacts_dir:
            command.extend(["--artifacts-dir", str(args.artifacts_dir)])
        command.append(str(binary))
        worker = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        passed = False
        try:
            try:
                code = worker.wait(timeout=120)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("Native first-run driver exceeded 120 seconds") from error
            if code:
                raise RuntimeError(f"Native first-run driver exited with {code}")
            passed = True
        finally:
            try:
                try:
                    os.killpg(worker.pid, signal.SIGTERM)
                    worker.wait(timeout=5)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
                finally:
                    try:
                        os.killpg(worker.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    worker.wait(timeout=5)
            finally:
                if not passed and (root / "app.log").is_file():
                    with (root / "app.log").open("rb") as log:
                        log.seek(0, os.SEEK_END)
                        log.seek(max(0, log.tell() - 8000))
                        print("Native app output (isolated environment):", file=sys.stderr)
                        print(log.read().decode(errors="replace"), file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
