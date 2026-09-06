import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import time
import tomllib

mode = sys.argv[1]
assert mode in ("produce", "consume")
checkout = Path.cwd()
original = checkout / "apps/shared/OpenClawWatchRTC"
work = Path(os.environ["RUNNER_TEMP"]) / "watch-rtc-freshness-probe"
work.mkdir()
source = original
build_output = work / "WatchRTC"
build_output.mkdir()
archive = work / f"watch-rtc-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}.tar.zst"
results = {"mode": mode, "timings_seconds": {}, "work": str(work)}

def capture(*command):
    return subprocess.check_output(command, text=True).strip()

def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def inventory(root):
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob("*")) if p.is_file()}

def public_path(value):
    path = Path(os.path.normpath(value))
    for label, root in public_roots.items():
        if path.is_relative_to(root):
            return f"{label}/{path.relative_to(root)}"
    return None

def filtered_trace(line):
    # Cargo debug reasons can contain old/new environment values. Emit only typed
    # reasons, approved public paths and numeric times; never forward raw trace.
    line = re.sub(r"\x1b\[[0-9;]*m", "", line)
    body = line.partition("cargo::compiler::fingerprint:")[2].strip()
    if body.startswith("stale: changed env"):
        return {"event": "changed-environment"}
    prefixes = ("stale:", "(vs)", "FileTime {", "dirty:", "dependency on", "fingerprint at:", "fingerprint dirty for", "fingerprint error for", "err:")
    if not body.startswith(prefixes):
        return None
    event = {"event": next(prefix for prefix in prefixes if body.startswith(prefix))}
    unit = re.search(r'target="([A-Za-z0-9_-]+)"', line)
    if unit:
        event["unit"] = unit[1]
    dependency = re.search(r"dependency on `([A-Za-z0-9_-]+)`", body)
    if dependency:
        event["dependency"] = dependency[1]
    reason = re.match(r"dirty: ([A-Za-z]+)", body)
    if reason:
        event["reason"] = reason[1]
        if "Env" in body or reason[1] not in ("FsStatusOutdated", "DepInfoOutputChanged", "RerunIfChangedOutputFileChanged", "RerunIfChangedOutputPathsChanged"):
            return event
    event["paths"] = [path for value in re.findall(r'"([^"\n]+)"', body) if value.startswith("/") and (path := public_path(value))]
    if body.startswith("fingerprint at:") and (path := public_path(body.removeprefix("fingerprint at:").strip())):
        event["paths"].append(path)
    event["times"] = [{"seconds": int(seconds), "nanos": int(nanos)} for seconds, nanos in re.findall(r"seconds: (-?\d+), nanos: (\d+)", body)]
    return event

def filtered_progress(line):
    line = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
    compiling = re.fullmatch(r"Compiling ([A-Za-z0-9_-]{1,128}) v([0-9][A-Za-z0-9.+-]{0,127})(?: \((/[^)\r\n]{1,4096})\))?", line)
    if compiling:
        path = public_path(compiling[3]) if compiling[3] else None
        if compiling[3] and path is None:
            return None
        return f"Compiling {compiling[1]} v{compiling[2]}" + (f" ({path})" if path else "") + "\n"
    if re.fullmatch(r"Finished `release` profile \[optimized\] target\(s\) in (?:[0-9]{1,5}m )?[0-9]{1,5}(?:\.[0-9]{1,6})?s", line):
        return line + "\n"
    return None

def measured(name, command, trace=False):
    start = time.monotonic()
    log = work / (name + ".log")
    with log.open("w") as output:
        environment = dict(os.environ)
        if trace:
            environment["CARGO_LOG"] = "cargo::compiler::fingerprint=trace"
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=environment)
        for line in child.stdout:
            if trace:
                projected = None
                if "cargo::compiler::fingerprint" in line:
                    event = filtered_trace(line)
                    if event is not None:
                        events = results.setdefault("fingerprint_events", [])
                        if len(events) < 2000:
                            events.append(event)
                            projected = json.dumps({"fingerprint": event}) + "\n"
                        else:
                            results["fingerprint_events_omitted"] = results.get("fingerprint_events_omitted", 0) + 1
                else:
                    projected = filtered_progress(line)
                if projected is None:
                    results["trace_lines_suppressed"] = results.get("trace_lines_suppressed", 0) + 1
                    continue
                line = projected
            print(line, end="", flush=True)
            output.write(line)
        code = child.wait()
    results["timings_seconds"][name] = time.monotonic() - start
    print(json.dumps({"phase": name, "seconds": results["timings_seconds"][name], "exit_code": code}), flush=True)
    if code:
        raise subprocess.CalledProcessError(code, command)
    return log.read_text()

# Reject inherited Cargo configuration rather than silently omitting it from identity.
cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
config_dirs = [cargo_home, *(parent / ".cargo" for parent in (checkout, *checkout.parents))]
assert not any((directory / name).exists() for directory in config_dirs for name in ("config", "config.toml")), "Unexpected inherited Cargo configuration"
toolchain = tomllib.loads((original / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
original_inputs = inventory(original)
sysroot = Path(capture("rustc", "+" + toolchain, "--print", "sysroot"))
rust_src = (sysroot / "lib/rustlib/src/rust/library").resolve()
public_roots = {"watch-source": original.resolve(), "rust-src": rust_src, "target": (build_output / "target").resolve(), "registry-source": (cargo_home / "registry/src").resolve()}
results["identity"] = {
    "commit": capture("git", "rev-parse", "HEAD"),
    "source_tree": capture("git", "rev-parse", "HEAD:apps/shared/OpenClawWatchRTC"),
    "inputs_sha256": original_inputs,
    "os": capture("sw_vers"),
    "architecture": capture("uname", "-m"),
    "runner_image": {key: os.environ.get(key) for key in ("ImageOS", "ImageVersion", "RUNNER_ARCH")},
    "rustc": capture("rustc", "+" + toolchain, "-vV"),
    "cargo": capture("cargo", "+" + toolchain, "-vV"),
    "rust_src_sha256": hashlib.sha256(json.dumps(inventory(sysroot / "lib/rustlib/src/rust/library"), sort_keys=True).encode()).hexdigest(),
    "xcode": capture("xcodebuild", "-version"),
    "sdk": capture("xcrun", "--sdk", "watchsimulator", "--show-sdk-path"),
    "sdk_version": capture("xcrun", "--sdk", "watchsimulator", "--show-sdk-version"),
    "sdk_build": capture("xcrun", "--sdk", "watchsimulator", "--show-sdk-build-version"),
    "clang": capture("xcrun", "--sdk", "watchsimulator", "clang", "--version"),
    "tar": capture("tar", "--version"),
    "zstd": capture("zstd", "--version"),
    "build_environment": {key: os.environ.get(key) for key in (
        "CARGO_BUILD_JOBS", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "WATCHOS_DEPLOYMENT_TARGET", "DEVELOPER_DIR", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_BUILD_RUSTFLAGS"
    )},
    "build_arguments": ["watchsimulator", "<output>", "arm64", "x86_64"],
}
assert results["identity"]["source_tree"] == "6e5d49f7be333c2c2edf43742ac5a1a77c77c3ca", "WatchRTC inputs moved from the reviewed source"
results["cpu_memory"] = capture("sysctl", "hw.logicalcpu", "hw.memsize")
results["paths"] = {"source": str(source), "output": str(build_output), "cargo_home": str(cargo_home), "sysroot": str(sysroot)}
# Identity is recomputed on each runner; the producer supplies only its digest.
def identity_digest(identity):
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

def require_identity(identity, expected):
    assert identity_digest(identity) == expected, "Consumer compiler/SDK/source identity differs from producer"

results["identity_sha256"] = identity_digest(results["identity"])
print(json.dumps(results["identity"], indent=2), flush=True)

def build(name, trace=False):
    return measured(name, ["bash", str(source / "build.sh"), "watchsimulator", str(build_output), "arm64", "x86_64"], trace)

def input_mtimes():
    records = []
    for target in ("aarch64-apple-watchos-sim", "x86_64-apple-watchos-sim"):
        for crate in ("core", "std"):
            refs = list((build_output / "target" / target / "release/build" / crate).glob(f"*/fingerprint/dep-lib-{crate}"))
            assert len(refs) == 1, "Expected one core/std dep-info per architecture"
            reference = refs[0]
            data = reference.read_bytes()
            assert data[:6] == bytes.fromhex("01000000ff01"), "Unsupported Cargo dep-info format"
            count = struct.unpack_from("<I", data, 6)[0]
            assert count <= 512
            offset = 10
            inputs = []
            for _ in range(count):
                kind = data[offset]
                length = struct.unpack_from("<I", data, offset + 1)[0]
                offset += 5
                assert length <= 4096 and offset + length < len(data)
                value = data[offset:offset + length].decode()
                offset += length
                assert data[offset] == 0, "Expected unchanged mtime fingerprint mode"
                offset += 1
                # Current core/std records refer to external rust-src paths. No
                # environment section is read or printed by this metadata probe.
                path = Path(value).resolve()
                assert kind == 1 and Path(value).is_absolute() and path.is_relative_to(rust_src)
                try:
                    mtime = path.stat().st_mtime_ns
                except FileNotFoundError:
                    mtime = None
                inputs.append({"path": public_path(value), "mtime_ns": mtime, "newer_than_reference": mtime is not None and mtime > reference.stat().st_mtime_ns})
            records.append({"reference": public_path(str(reference)), "reference_mtime_ns": reference.stat().st_mtime_ns, "inputs": inputs})
    return records

try:
    if mode == "produce":
        build("cold_build")
        results["producer_input_mtimes"] = input_mtimes()
        target = build_output / "target"
        assert set(capture("xcrun", "lipo", "-archs", str(build_output / "libopenclaw_watch_rtc.a")).split()) == {"arm64", "x86_64"}
        results["target_bytes"] = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
        results["target_disk_usage"] = capture("du", "-sk", str(target))
        # Publish only successful unchanged-source compiler products, never the freshness-control variant.
        measured("archive", ["bash", "-euo", "pipefail", "-c", 'tar -C "$1" -cf - target | zstd -T0 -3 -o "$2"', "probe", str(build_output), str(archive)])
        results["archive_bytes"] = archive.stat().st_size
        results["archive_sha256"] = sha(archive)
        assert inventory(source) == original_inputs
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key, value in {"archive_path": str(archive), "archive_name": archive.name, "archive_sha256": results["archive_sha256"], "identity_sha256": results["identity_sha256"]}.items():
                output.write(f"{key}={value}\n")
    else:
        require_identity(results["identity"], os.environ["PROBE_IDENTITY_SHA256"])
        # Synthetic identity controls exercise rejection before any artifact is extracted.
        for field in ("sdk_build", "rustc", "source_tree", "build_arguments"):
            changed = dict(results["identity"], **{field: "synthetic-incompatible-input"})
            try:
                require_identity(changed, os.environ["PROBE_IDENTITY_SHA256"])
            except AssertionError:
                pass
            else:
                raise AssertionError(f"Incompatible {field} was admitted")
        assert not any(build_output.iterdir())
        results["identity_controls"] = "SDK, compiler, source and target mismatches rejected before extraction"
        archive = Path(os.environ["PROBE_ARCHIVE"])
        verify_started = time.monotonic()
        assert sha(archive) == os.environ["PROBE_ARCHIVE_SHA256"], "Downloaded archive differs from producer"
        results["timings_seconds"]["verify_archive"] = time.monotonic() - verify_started
        measured("extract", ["bash", "-euo", "pipefail", "-c", 'zstd -dc "$1" | tar -C "$2" -xf -', "probe", str(archive), str(build_output)])
        results["pre_build_input_mtimes"] = input_mtimes()
        print(json.dumps({"pre_build_input_mtimes": results["pre_build_input_mtimes"]}), flush=True)
        warm_log = build("cross_job_warm_build", trace=True)
        results["warm_compiling_lines"] = [line.strip() for line in warm_log.splitlines() if "Compiling " in line]
        dirty_events = [event for event in results.get("fingerprint_events", []) if event["event"] in ("stale:", "dirty:", "changed-environment", "fingerprint error for", "err:")]
        assert not results["warm_compiling_lines"] or dirty_events, "Recompilation lacked filtered dirty-reason evidence"
        results["first_dirty_event"] = next(iter(dirty_events), None)
        results["verify_extract_build_seconds"] = sum(results["timings_seconds"][phase] for phase in ("verify_archive", "extract", "cross_job_warm_build"))
        assert set(capture("xcrun", "lipo", "-archs", str(build_output / "libopenclaw_watch_rtc.a")).split()) == {"arm64", "x86_64"}
        results["first_result_sha256"] = sha(build_output / "libopenclaw_watch_rtc.a")
        first_output = work / "preserved-restored-result"
        build_output.rename(first_output)
        build_output.mkdir()
        assert not any(build_output.iterdir()), "Cold control target must start empty"
        results["consumer_order"] = ["restored build", "empty-target cold control", "restore preserved lineage", "disposable-source baseline", "source mutation"]
        results["cold_control_caveat"] = "Same source, output path, flags and host; registry and toolchain are warm from the restored build; filesystem cache and tracing overhead differ."
        cold_log = build("same_consumer_cold_build")
        results["cold_control_compiling_lines"] = [line.strip() for line in cold_log.splitlines() if "Compiling " in line]
        assert set(capture("xcrun", "lipo", "-archs", str(build_output / "libopenclaw_watch_rtc.a")).split()) == {"arm64", "x86_64"}
        # Freshness must continue from the restored result, not the cold control.
        # Keep both originals and copy timestamps with the restored artifacts.
        lineage_started = time.monotonic()
        build_output.rename(work / "preserved-cold-result")
        shutil.copytree(first_output, build_output, symlinks=True, copy_function=shutil.copy2)
        results["timings_seconds"]["restore_first_result_lineage"] = time.monotonic() - lineage_started
        assert sha(build_output / "libopenclaw_watch_rtc.a") == results["first_result_sha256"], "Freshness baseline lost restored lineage"
        source = work / "freshness-source"
        shutil.copytree(original, source)
        assert inventory(source) == original_inputs
        build("disposable_source_baseline")
        targets = ("aarch64-apple-watchos-sim", "x86_64-apple-watchos-sim")
        symbol = "openclaw_rtc_probe_freshness_20260906"
        host = next(line.removeprefix("host: ") for line in results["identity"]["rustc"].splitlines() if line.startswith("host: "))
        llvm_nm = sysroot / "lib/rustlib" / host / "bin/llvm-nm"
        results["llvm_nm"] = capture(str(llvm_nm), "--version")
        def slice_symbols(target):
            symbols = capture(str(llvm_nm), "--defined-only", "--extern-only", "--just-symbol-name", str(build_output / "target" / target / "release/libopenclaw_watch_rtc.a"))
            return {line.removeprefix("_") for line in symbols.splitlines()}
        assert all(symbol not in slice_symbols(target) for target in targets)
        # Change only the disposable source copy; an exported function must appear in both rebuilt slices.
        lib = source / "src/lib.rs"
        with lib.open("a") as output:
            output.write('\n#[unsafe(no_mangle)]\npub extern "C" fn openclaw_rtc_probe_freshness_20260906() -> u32 { 20260906 }\n')
        results["changed_source_sha256"] = sha(lib)
        changed_log = build("changed_source_build")
        assert changed_log.count("Compiling openclaw-watch-rtc ") == 2, "Expected the source crate to compile for both slices"
        assert all(symbol in slice_symbols(target) for target in targets), "Changed function missing from a rebuilt slice"
        results["freshness_control"] = "Both simulator slices recompiled and contain the new exported function"
        results["architectures"] = capture("xcrun", "lipo", "-archs", str(build_output / "libopenclaw_watch_rtc.a"))
        assert set(results["architectures"].split()) == {"arm64", "x86_64"}
        assert sha(first_output / "libopenclaw_watch_rtc.a") == results["first_result_sha256"], "First restored result changed during controls"
finally:
    assert inventory(original) == original_inputs, "Canonical source changed"
    print(json.dumps(results, indent=2), flush=True)
    (work / "results.json").write_text(json.dumps(results, indent=2) + "\n")
