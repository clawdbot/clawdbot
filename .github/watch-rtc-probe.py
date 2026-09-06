import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib

mode = sys.argv[1]
assert mode in ("produce", "consume")
checkout = Path.cwd()
original = checkout / "apps/shared/OpenClawWatchRTC"
work = Path(tempfile.mkdtemp(prefix="watch-rtc-probe-", dir=os.environ["RUNNER_TEMP"]))
source = work / "source"
cold = work / "cold"
restored = work / "restored"
archive = work / f"watch-rtc-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}.tar.zst"
results = {"mode": mode, "timings_seconds": {}, "work": str(work)}

def capture(*command):
    return subprocess.check_output(command, text=True).strip()

def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def inventory(root):
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob("*")) if p.is_file()}

def measured(name, command):
    start = time.monotonic()
    log = work / (name + ".log")
    with log.open("w") as output:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in child.stdout:
            print(line, end="", flush=True)
            output.write(line)
        code = child.wait()
    results["timings_seconds"][name] = time.monotonic() - start
    print(json.dumps({"phase": name, "seconds": results["timings_seconds"][name], "exit_code": code}), flush=True)
    if code:
        raise subprocess.CalledProcessError(code, command)
    return log.read_text()

# The copied module has no Cargo configuration; reject inherited config instead of silently omitting it from identity.
cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
config_dirs = [cargo_home, *(parent / ".cargo" for parent in (checkout, *checkout.parents))]
assert not any((directory / name).exists() for directory in config_dirs for name in ("config", "config.toml")), "Unexpected inherited Cargo configuration"
toolchain = tomllib.loads((original / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
original_inputs = inventory(original)
shutil.copytree(original, source)
assert inventory(source) == original_inputs
cold.mkdir()
restored.mkdir()
sysroot = Path(capture("rustc", "+" + toolchain, "--print", "sysroot"))
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
assert results["identity"]["source_tree"] == "3604c392e1321c147b3f59e880957cb2d769ce4d", "WatchRTC inputs moved from the reviewed source"
results["cpu_memory"] = capture("sysctl", "hw.logicalcpu", "hw.memsize")
results["paths"] = {"source": str(source), "cargo_home": str(cargo_home), "sysroot": str(sysroot)}
# Identity is recomputed on each runner; the producer supplies only its digest.
def identity_digest(identity):
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

def require_identity(identity, expected):
    assert identity_digest(identity) == expected, "Consumer compiler/SDK/source identity differs from producer"

results["identity_sha256"] = identity_digest(results["identity"])
print(json.dumps(results["identity"], indent=2), flush=True)

def build(name, destination):
    return measured(name, ["bash", str(source / "build.sh"), "watchsimulator", str(destination), "arm64", "x86_64"])

try:
    if mode == "produce":
        build("cold_build", cold)
        target = cold / "target"
        assert set(capture("xcrun", "lipo", "-archs", str(cold / "libopenclaw_watch_rtc.a")).split()) == {"arm64", "x86_64"}
        results["target_bytes"] = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
        results["target_disk_usage"] = capture("du", "-sk", str(target))
        # Publish only successful unchanged-source compiler products, never the freshness-control variant.
        measured("archive", ["bash", "-euo", "pipefail", "-c", 'tar -C "$1" -cf - target | zstd -T0 -3 -o "$2"', "probe", str(cold), str(archive)])
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
        assert not any(restored.iterdir())
        results["identity_controls"] = "SDK, compiler, source and target mismatches rejected before extraction"
        archive = Path(os.environ["PROBE_ARCHIVE"])
        verify_started = time.monotonic()
        assert sha(archive) == os.environ["PROBE_ARCHIVE_SHA256"], "Downloaded archive differs from producer"
        results["timings_seconds"]["verify_archive"] = time.monotonic() - verify_started
        measured("extract", ["bash", "-euo", "pipefail", "-c", 'zstd -dc "$1" | tar -C "$2" -xf -', "probe", str(archive), str(restored)])
        warm_log = build("cross_job_warm_build", restored)
        results["warm_compiling_lines"] = [line.strip() for line in warm_log.splitlines() if "Compiling " in line]
        results["verify_extract_build_seconds"] = sum(results["timings_seconds"][phase] for phase in ("verify_archive", "extract", "cross_job_warm_build"))
        targets = ("aarch64-apple-watchos-sim", "x86_64-apple-watchos-sim")
        symbol = "openclaw_rtc_probe_freshness_20260906"
        host = next(line.removeprefix("host: ") for line in results["identity"]["rustc"].splitlines() if line.startswith("host: "))
        llvm_nm = sysroot / "lib/rustlib" / host / "bin/llvm-nm"
        results["llvm_nm"] = capture(str(llvm_nm), "--version")
        def slice_symbols(target):
            symbols = capture(str(llvm_nm), "--defined-only", "--extern-only", "--just-symbol-name", str(restored / "target" / target / "release/libopenclaw_watch_rtc.a"))
            return {line.removeprefix("_") for line in symbols.splitlines()}
        assert all(symbol not in slice_symbols(target) for target in targets)
        # Change only the disposable source copy; an exported function must appear in both rebuilt slices.
        lib = source / "src/lib.rs"
        with lib.open("a") as output:
            output.write('\n#[unsafe(no_mangle)]\npub extern "C" fn openclaw_rtc_probe_freshness_20260906() -> u32 { 20260906 }\n')
        results["changed_source_sha256"] = sha(lib)
        changed_log = build("changed_source_build", restored)
        assert changed_log.count("Compiling openclaw-watch-rtc ") == 2, "Expected the source crate to compile for both slices"
        assert all(symbol in slice_symbols(target) for target in targets), "Changed function missing from a rebuilt slice"
        results["freshness_control"] = "Both simulator slices recompiled and contain the new exported function"
        results["architectures"] = capture("xcrun", "lipo", "-archs", str(restored / "libopenclaw_watch_rtc.a"))
        assert set(results["architectures"].split()) == {"arm64", "x86_64"}
finally:
    assert inventory(original) == original_inputs, "Canonical source changed"
    print(json.dumps(results, indent=2), flush=True)
    (work / "results.json").write_text(json.dumps(results, indent=2) + "\n")
