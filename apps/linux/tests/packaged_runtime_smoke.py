#!/usr/bin/env python3
"""Collect evidence and smoke-test a Linux companion AppImage.

Run as a non-root user inside a private X11 and D-Bus session:
  xvfb-run -a dbus-run-session -- \
    python3 apps/linux/tests/packaged_runtime_smoke.py APPIMAGE --output DIR
"""

import argparse
from fnmatch import fnmatchcase
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


REQUIRED_GSTREAMER_ELEMENTS = (
    "filesrc",
    "queue",
    "typefind",
    "typefindfunctions",
    "appsrc",
    "appsink",
    "giosrc",
    "souphttpsrc",
    "playbin",
    "decodebin",
    "audioconvert",
    "audioresample",
    "volume",
    "videoconvert",
    "videoscale",
    "videorate",
    "autoaudiosink",
    "pulsesink",
    "qtdemux",
    "matroskademux",
    "wavparse",
    "oggdemux",
    "opusparse",
    "opusdec",
    "vorbisdec",
    "vp8dec",
    "vp9dec",
    "aacparse",
    "h264parse",
    "id3demux",
    "mpegaudioparse",
    "avdec_aac",
    "avdec_h264",
    "avdec_mp3",
)

FORBIDDEN_APPIMAGE_LIBRARY_PATTERNS = (
    "libwayland-client.so*",
    "libwayland-cursor.so*",
    "libwayland-egl.so*",
    "libwayland-server.so*",
)

ABI_LIMITS = {
    "GLIBC": "2.35",
    "GLIBCXX": "3.4.30",
    # Keep the C++ and libgcc symbol ceilings paired to the GCC 12.1 runtime.
    "CXXABI": "1.3.13",
    "GCC": "12.0.0",
}

ABI_ALLOWED_VARIANTS = {
    "x86_64": {
        "CXXABI": frozenset(("FLOAT128", "TM_1")),
    },
    "aarch64": {},
}

ELF_MACHINE_ARCHITECTURES = {
    "Advanced Micro Devices X86-64": "x86_64",
    "AArch64": "aarch64",
}

GSTREAMER_TOOL_NAMES = (
    "gst-inspect-1.0",
    "gst-launch-1.0",
)


def version_key(version):
    return tuple(int(part) for part in version.split("."))


def is_numeric_version(version):
    return re.fullmatch(r"\d+(?:\.\d+)*", version) is not None


def requirement_sort_key(version):
    if is_numeric_version(version):
        return (0, version_key(version), "")
    return (1, (), version)


def compare_versions(left, right):
    left_parts = version_key(left)
    right_parts = version_key(right)
    length = max(len(left_parts), len(right_parts))
    return (
        left_parts + (0,) * (length - len(left_parts))
        > right_parts + (0,) * (length - len(right_parts))
    )


def normalize_architecture(machine, source):
    normalized = machine.strip().lower()
    if normalized in ("x86_64", "amd64"):
        return "x86_64"
    if normalized in ("aarch64", "arm64"):
        return "aarch64"
    raise RuntimeError(f"unsupported {source} architecture {machine}")


def parse_version_needs(text, source, architecture):
    requirements = {family: set() for family in ABI_LIMITS}
    in_version_needs = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("Version needs section "):
            in_version_needs = True
            continue
        if line.startswith("Version ") and " section " in line:
            in_version_needs = False
            continue
        if not in_version_needs:
            continue
        match = re.search(r"\bName:\s*(\S+)", line)
        if match is None:
            continue
        name = match.group(1)
        family = None
        for candidate in ABI_LIMITS:
            prefix = f"{candidate}_"
            if name.startswith(prefix):
                family = candidate
                version = name.removeprefix(prefix)
                break
        if family is None:
            continue
        if (
            not is_numeric_version(version)
            and version
            not in ABI_ALLOWED_VARIANTS.get(architecture, {}).get(family, ())
        ):
            raise RuntimeError(f"{source} requires unknown {family} version {name}")
        requirements[family].add(version)
    return {
        family: sorted(versions, key=requirement_sort_key)
        for family, versions in requirements.items()
    }


def is_regular_elf(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open("rb") as source:
        return source.read(4) == b"\x7fELF"


def run_readelf(path, source, readelf, *arguments):
    result = subprocess.run(
        [readelf, *arguments, "--wide", str(path)],
        env={**os.environ, "LC_ALL": "C"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if result.returncode:
        detail = result.stdout.strip().replace(str(path), source)
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"readelf failed for {source} with exit {result.returncode}{suffix}"
        )
    return result.stdout


def read_elf_architecture(path, source, readelf):
    text = run_readelf(path, source, readelf, "--file-header")
    match = re.search(r"^\s*Machine:\s*(.+?)\s*$", text, re.MULTILINE)
    if match is None:
        raise RuntimeError(f"readelf did not report an ELF machine for {source}")
    machine = match.group(1)
    try:
        return ELF_MACHINE_ARCHITECTURES[machine]
    except KeyError as error:
        raise RuntimeError(
            f"{source} uses unsupported ELF machine {machine}"
        ) from error


def read_abi_requirements(path, source, readelf, architecture):
    return parse_version_needs(
        run_readelf(path, source, readelf, "--version-info"),
        source,
        architecture,
    )


def collect_abi_report(appimage, appdir, readelf=None):
    readelf = readelf or shutil.which("readelf")
    if readelf is None:
        raise RuntimeError("readelf is required for AppImage ABI inspection")
    if not is_regular_elf(appimage):
        raise RuntimeError(f"{appimage.name} is not a regular ELF AppImage runtime")
    architecture = read_elf_architecture(
        appimage,
        "appimage-runtime",
        readelf,
    )
    host_architecture = normalize_architecture(platform.machine(), "host")
    if architecture != host_architecture:
        raise RuntimeError(
            "AppImage architecture mismatch: "
            f"artifact is {architecture}, host is {host_architecture}"
        )

    candidates = [
        {
            "path": appimage,
            "reportPath": appimage.name,
            "source": "appimage-runtime",
        }
    ]
    candidates.extend(
        {
            "path": path,
            "reportPath": path.relative_to(appdir).as_posix(),
            "source": "appdir",
        }
        for path in appdir.rglob("*")
        if is_regular_elf(path)
    )
    files = []
    for candidate in sorted(
        candidates,
        key=lambda item: (item["reportPath"], item["source"]),
    ):
        files.append(
            {
                "path": candidate["reportPath"],
                "source": candidate["source"],
                "requires": read_abi_requirements(
                    candidate["path"],
                    candidate["reportPath"],
                    readelf,
                    architecture,
                ),
            }
        )

    maximum_required = {}
    for family in ABI_LIMITS:
        versions = [
            version
            for entry in files
            for version in entry["requires"][family]
            if is_numeric_version(version)
        ]
        maximum_required[family] = (
            max(versions, key=version_key) if versions else None
        )
    return {
        "architecture": architecture,
        "files": files,
        "limits": ABI_LIMITS,
        "maximumRequired": maximum_required,
    }


def write_abi_report(output, report):
    (output / "abi.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n"
    )


def enforce_abi_limits(report):
    violations = []
    for entry in report["files"]:
        for family, limit in ABI_LIMITS.items():
            for version in entry["requires"][family]:
                if not is_numeric_version(version):
                    continue
                if compare_versions(version, limit):
                    violations.append(
                        f"{entry['path']} requires {family}_{version} (limit {family}_{limit})"
                    )
    if violations:
        raise RuntimeError("AppImage ABI floor exceeded: " + "; ".join(violations))


def write_command(output, name, command, *, cwd=None, env=None):
    path = output / name
    executable = shutil.which(command[0])
    if executable is None:
        path.write_text(f"{command[0]}: not installed\n")
        return 127, ""
    result = subprocess.run(
        [executable, *command[1:]],
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    path.write_text(result.stdout)
    return result.returncode, result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def isolated_environment(root):
    env = {
        key: os.environ[key]
        for key in (
            "DBUS_SESSION_BUS_ADDRESS",
            "DISPLAY",
            "LANG",
            "LC_ALL",
            "XAUTHORITY",
            "XDG_RUNTIME_DIR",
            "XDG_SESSION_TYPE",
        )
        if key in os.environ
    }
    env.update(HOME=str(root), PATH="/usr/bin:/bin")
    for variable, relative in (
        ("XDG_CONFIG_HOME", ".config"),
        ("XDG_CACHE_HOME", ".cache"),
        ("XDG_DATA_HOME", ".local/share"),
        ("XDG_STATE_HOME", ".local/state"),
        ("TMPDIR", "tmp"),
    ):
        path = root / relative
        path.mkdir(mode=0o700, parents=True)
        env[variable] = str(path)
    return env


def resolve_gstreamer_tools(directory=None, search_path="/usr/bin:/bin"):
    resolved = []
    for name in GSTREAMER_TOOL_NAMES:
        if directory is None:
            executable = shutil.which(name, path=search_path)
            if executable is None:
                raise RuntimeError(
                    f"GStreamer tool {name} not found in {search_path}"
                )
            path = Path(executable).resolve()
        else:
            candidate = Path(directory) / name
            if not candidate.is_file():
                raise RuntimeError(f"GStreamer tool {name} is missing: {candidate}")
            if not os.access(candidate, os.X_OK):
                raise RuntimeError(
                    f"GStreamer tool {name} is not executable: {candidate}"
                )
            path = candidate.resolve()
        resolved.append(path)
    return tuple(resolved)


def process_ids(root_pid):
    found = {root_pid}
    pending = [root_pid]
    while pending:
        parent = pending.pop()
        result = subprocess.run(
            ["pgrep", "-P", str(parent)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        for value in result.stdout.split():
            child = int(value)
            if child not in found:
                found.add(child)
                pending.append(child)
    return sorted(found)


def launch_probe(command, output, label, *, cwd, env, duration=5):
    with (output / f"{label}.log").open("wb") as log:
        app = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + duration
            while time.monotonic() < deadline and app.poll() is None:
                time.sleep(0.1)
            if app.poll() is not None:
                return {"alive": False, "exitCode": app.returncode, "pids": []}
            pids = process_ids(app.pid)
            write_command(
                output,
                f"{label}.processes.txt",
                ["ps", "-ww", "-o", "pid,ppid,stat,comm,args", "-p", ",".join(map(str, pids))],
            )
            write_command(output, f"{label}.tree.txt", ["pstree", "-ap", str(app.pid)])
            write_command(output, f"{label}.windows.txt", ["wmctrl", "-lpGx"])
            with (output / f"{label}.maps.txt").open("w") as maps:
                for pid in pids:
                    path = Path(f"/proc/{pid}/maps")
                    if path.is_file():
                        maps.write(f"== pid {pid} ==\n")
                        maps.write(path.read_text(errors="replace"))
            return {"alive": True, "exitCode": None, "pids": pids}
        finally:
            if app.poll() is None:
                os.killpg(app.pid, signal.SIGTERM)
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(app.pid, signal.SIGKILL)
                    app.wait(timeout=5)


def container_shell_probe(image, appdir, output):
    results = {}
    failed = []
    for shell in ("sh", "bash"):
        command = [
            "docker",
            "run",
            "--rm",
            "--entrypoint",
            f"/bin/{shell}",
            "--env",
            "LD_LIBRARY_PATH=/openclaw-libs",
            "--volume",
            f"{appdir / 'usr/lib'}:/openclaw-libs:ro",
            image,
            "-lc",
            f"printf '{shell}-ok\\n'",
        ]
        code, text = write_command(output, f"container-{shell}.txt", command)
        results[shell] = {"exitCode": code, "output": text.strip()}
        if code:
            failed.append(shell)
    if failed:
        raise RuntimeError(
            f"{image} packaged-library shell probe failed: {', '.join(failed)}"
        )
    return results


def generate_media_samples(root, output):
    samples = root / "media"
    samples.mkdir()
    commands = {
        "wav": [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.25",
        ],
        "mp3": [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.25",
            "-c:a",
            "libmp3lame",
        ],
        "ogg": [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.25",
            "-c:a",
            "libvorbis",
        ],
        "webm": [
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=10:duration=0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.25",
            "-c:v",
            "libvpx-vp9",
            "-c:a",
            "libopus",
            "-shortest",
        ],
        "mp4": [
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=10:duration=0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.25",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ],
    }
    generated = []
    for extension, arguments in commands.items():
        sample = samples / f"sample.{extension}"
        code, _ = write_command(
            output,
            f"generate-{extension}.txt",
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *arguments, str(sample)],
        )
        if code:
            raise RuntimeError(f"Failed to generate {extension} media sample")
        generated.append(sample)
    return generated


def bundled_gstreamer_probe(
    appdir,
    output,
    env,
    samples,
    *,
    gst_inspect,
    gst_launch,
):
    hook = appdir / "apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
    if not hook.is_file():
        raise RuntimeError("Missing packaged GStreamer AppRun hook")

    common = """
set -euo pipefail
export APPDIR=$1
source "$APPDIR/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
# Refuse host plugin fallback: this is a contract test for the AppImage payload.
export GST_PLUGIN_PATH_1_0=
export GST_PLUGIN_SYSTEM_PATH_1_0="$APPDIR/usr/lib/gstreamer-1.0"
"""
    command = [
        "/bin/bash",
        "-c",
        common
        + """
gst_inspect=$2
shift 2
for element; do
  "$gst_inspect" "$element" >/dev/null
  printf '%s\\tok\\n' "$element"
done
""",
        "bundled-gstreamer-probe",
        str(appdir),
        str(gst_inspect),
        *REQUIRED_GSTREAMER_ELEMENTS,
    ]
    code, text = write_command(
        output,
        "bundled-gstreamer-elements.txt",
        command,
        cwd=appdir,
        env=env,
    )
    if code:
        raise RuntimeError("Packaged GStreamer element probe failed")

    playback = {}
    registry = output / "gstreamer-registry.bin"
    for sample in samples:
        code, media_output = write_command(
            output,
            f"playback-{sample.suffix.removeprefix('.')}.txt",
            [
                "/bin/bash",
                "-c",
                common
                + """
export GST_REGISTRY_1_0=$2
exec timeout 30s "$4" -q playbin "uri=file://$3" \
  audio-sink=fakesink video-sink=fakesink
""",
                "bundled-gstreamer-playback",
                str(appdir),
                str(registry),
                str(sample),
                str(gst_launch),
            ],
            cwd=appdir,
            env=env,
        )
        playback[sample.suffix.removeprefix(".")] = {
            "exitCode": code,
            "output": media_output.strip(),
        }
        if code:
            raise RuntimeError(f"Packaged playback failed for {sample.name}")
    return {
        "elements": text.splitlines(),
        "playback": playback,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimage", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-sha256")
    parser.add_argument("--gstreamer-tools-dir", type=Path)
    parser.add_argument("--require-fuse", action="store_true")
    parser.add_argument("--shell-container")
    parser.add_argument("--skip-ui", action="store_true")
    args = parser.parse_args()

    if sys.platform != "linux" or os.geteuid() == 0:
        parser.error("Run on Linux as a non-root user")
    for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS"):
        if not os.environ.get(key):
            parser.error("Run inside xvfb-run and dbus-run-session")

    appimage = args.appimage.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    artifact_sha = sha256(appimage)
    (output / "sha256.txt").write_text(f"{artifact_sha}  {appimage.name}\n")
    if args.expected_sha256 and artifact_sha != args.expected_sha256.lower():
        raise RuntimeError(f"SHA-256 mismatch: got {artifact_sha}")

    write_command(output, "uname.txt", ["uname", "-a"])
    if Path("/etc/os-release").is_file():
        shutil.copyfile("/etc/os-release", output / "os-release.txt")
    (output / "display-environment.txt").write_text(
        "".join(
            f"{key}={os.environ.get(key, '')}\n"
            for key in ("DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "GDK_BACKEND")
        )
    )
    for name, command in (
        ("artifact-file.txt", ["file", str(appimage)]),
        ("display.txt", ["xdpyinfo"]),
        ("glx.txt", ["glxinfo", "-B"]),
        ("egl.txt", ["eglinfo", "-B"]),
        ("pci.txt", ["lspci", "-nnk"]),
        ("gstreamer.txt", ["gst-inspect-1.0", "--version"]),
    ):
        write_command(output, name, command)

    with tempfile.TemporaryDirectory(prefix="openclaw-packaged-smoke-") as directory:
        root = Path(directory)
        env = isolated_environment(root / "home")
        fuse = launch_probe(
            [str(appimage)],
            output,
            "fuse-launch",
            cwd=root,
            env=env,
        )
        if args.require_fuse and not fuse["alive"]:
            raise RuntimeError(f"FUSE launch exited with {fuse['exitCode']}")

        extract = subprocess.run(
            [str(appimage), "--appimage-extract"],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        (output / "extract.log").write_text(extract.stdout)
        if extract.returncode:
            raise RuntimeError(f"AppImage extraction exited with {extract.returncode}")
        appdir = root / "squashfs-root"
        apprun = appdir / "AppRun"
        binary = appdir / "usr/bin/openclaw-desktop"
        for required in (apprun, binary):
            if not required.is_file():
                raise RuntimeError(f"Missing packaged runtime file: {required.relative_to(appdir)}")

        abi_report = collect_abi_report(appimage, appdir)
        write_abi_report(output, abi_report)
        enforce_abi_limits(abi_report)

        usr_lib = appdir / "usr/lib"
        forbidden_libraries = sorted(
            path.relative_to(appdir).as_posix()
            for path in usr_lib.rglob("*")
            if (path.is_file() or path.is_symlink())
            and any(
                fnmatchcase(path.name, pattern)
                for pattern in FORBIDDEN_APPIMAGE_LIBRARY_PATTERNS
            )
        )
        if forbidden_libraries:
            raise RuntimeError(
                "AppImage bundles host Wayland libraries: "
                + ", ".join(forbidden_libraries)
            )

        shutil.copyfile(apprun, output / "AppRun.txt")
        hooks = appdir / "apprun-hooks"
        if hooks.is_dir():
            for hook in hooks.glob("*"):
                if hook.is_file():
                    shutil.copyfile(hook, output / hook.name)
        write_command(output, "binary-dynamic.txt", ["readelf", "-dW", str(binary)])
        _, ldd = write_command(output, "binary-ldd.txt", ["ldd", str(binary)])
        if "not found" in ldd:
            raise RuntimeError("Packaged desktop binary has unresolved dynamic libraries")

        libraries = sorted(
            path.relative_to(appdir).as_posix()
            for path in (appdir / "usr/lib").rglob("*")
            if path.is_file()
        )
        (output / "libraries.txt").write_text("\n".join(libraries) + "\n")

        library_paths = [
            appdir / "usr/lib",
            appdir / "usr/lib/x86_64-linux-gnu",
            appdir / "usr/lib/aarch64-linux-gnu",
        ]
        shell_env = dict(env)
        shell_env["LD_LIBRARY_PATH"] = ":".join(
            str(path) for path in library_paths if path.is_dir()
        )
        gst_inspect, gst_launch = resolve_gstreamer_tools(
            args.gstreamer_tools_dir
        )
        selected_version_code, _ = write_command(
            output,
            "gstreamer-selected-tool.txt",
            [str(gst_inspect), "--version"],
            cwd=appdir,
            env=shell_env,
        )
        if selected_version_code:
            raise RuntimeError(
                "Selected gst-inspect-1.0 failed under the packaged library path"
            )
        shell_results = {}
        for shell in ("/bin/sh", "/bin/bash"):
            if not Path(shell).is_file():
                continue
            code, text = write_command(
                output,
                f"{Path(shell).name}-probe.txt",
                [shell, "-lc", f"printf '{Path(shell).name}-ok\\n'"],
                cwd=appdir,
                env=shell_env,
            )
            shell_results[shell] = {"exitCode": code, "output": text.strip()}
            if code:
                raise RuntimeError(f"{shell} failed under the packaged library path")

        container_shells = None
        if args.shell_container:
            container_shells = container_shell_probe(
                args.shell_container,
                appdir,
                output,
            )

        samples = generate_media_samples(root, output)
        gstreamer = bundled_gstreamer_probe(
            appdir,
            output,
            shell_env,
            samples,
            gst_inspect=gst_inspect,
            gst_launch=gst_launch,
        )

        extracted = launch_probe(
            [str(apprun)],
            output,
            "extract-launch",
            cwd=appdir,
            env=env,
        )
        if not extracted["alive"]:
            raise RuntimeError(f"Extracted AppRun exited with {extracted['exitCode']}")

        ui_code = None
        if not args.skip_ui:
            ui_env = dict(env)
            # AT-SPI creates a Unix socket below TMPDIR. The isolated HOME path
            # can exceed sockaddr_un's limit in deep CI workspaces.
            with tempfile.TemporaryDirectory(prefix="openclaw-ui-") as ui_tmp:
                ui_env["TMPDIR"] = ui_tmp
                ui_code, _ = write_command(
                    output,
                    "atspi-first-run.txt",
                    [
                        sys.executable,
                        str(Path(__file__).with_name("first_run.py")),
                        "--remote-only",
                        str(apprun),
                    ],
                    cwd=appdir,
                    env=ui_env,
                )
            if ui_code:
                raise RuntimeError("Packaged first-run AT-SPI smoke failed")

        summary = {
            "artifact": appimage.name,
            "sha256": artifact_sha,
            "fuse": fuse,
            "extracted": extracted,
            "shells": shell_results,
            "containerShells": container_shells,
            "gstreamer": gstreamer,
            "uiExitCode": ui_code,
        }
        (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    print(f"PASS: packaged Linux runtime smoke ({appimage.name})")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
