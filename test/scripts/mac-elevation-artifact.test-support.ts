import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  compiledMacNativeFixtures,
  macFatContainerFixture,
  macObjectFixture,
  runMacFixtureTool,
  singleSliceMacFat64,
} from "./mac-native-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceCommit = "a".repeat(40);
const peekabooCommit = "b".repeat(40);
const buildInfo = {
  version: "4.2.0",
  commit: sourceCommit,
  builtAt: "2026-08-28T00:00:00Z",
  buildId: "fixture-build",
};
const authority = "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)";
const entitlements = "<plist><dict/></plist>\n";
const workerRoot = "Contents/Resources/node-worker";
const workerDist = "lib/node_modules/openclaw/dist";
const addon = "lib/node_modules/native [fixture]/addon.node";
// Universal file output repeats the path; names must not choose the binary format.
const library = "lib/node_modules/native [fixture]/library ERROR COFF.dylib";
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function digest(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function write(file: string, contents: string | Buffer, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, mode);
}

const machResourceKinds = [
  "object",
  "synthetic-core",
  "synthetic-dylib-stub",
  "synthetic-dsym",
] as const;

function withMachResourceKind(
  contents: Buffer,
  kind: (typeof machResourceKinds)[number] | "archive",
) {
  if (kind === "archive") {
    return contents;
  }
  const bytes = Buffer.from(contents);
  // lipo -create ignores MH_CORE inputs. Build real object containers first, then
  // change only their object header kinds: these are synthetic controls, not dumps.
  const filetypes = {
    object: 1,
    "synthetic-core": 4,
    "synthetic-dylib-stub": 9,
    "synthetic-dsym": 10,
  };
  const magic = bytes.readUInt32BE(0);
  const offsets = [0];
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const fat64 = magic === 0xcafebabf;
    expect(bytes.readUInt32BE(4)).toBe(2);
    offsets.length = 0;
    for (let index = 0; index < 2; index++) {
      const entry = 8 + index * (fat64 ? 32 : 20);
      offsets.push(
        fat64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8),
      );
    }
  }
  for (const offset of offsets) {
    expect(bytes.readUInt32BE(offset)).toBe(0xcffaedfe);
    if (bytes.readUInt32LE(offset + 12) === 1) {
      bytes.writeUInt32LE(filetypes[kind], offset + 12);
    }
  }
  return bytes;
}

export function artifactFixture() {
  const root = tempDirs.make("openclaw-elevation-native-");
  const binaries = compiledMacNativeFixtures(root);
  const home = path.join(root, "home [portable]");
  const payload = path.join(root, "payload [archive]");
  const app = path.join(payload, "OpenClaw.app");
  const bin = path.join(home, "bin");
  const installer = path.join(home, "elevation-installer.sh");
  const archive = path.join(home, "elevation.zip");
  const receiptPath = path.join(home, "elevation.json");
  const calls = path.join(home, "policy-calls");
  const fileCalls = path.join(home, "file-calls");
  const forbidden = path.join(home, "forbidden-calls");
  mkdirSync(bin, { recursive: true });
  write(installer, readFileSync("scripts/mac-elevation-host.sh"), 0o555);
  write(calls, "");
  write(fileCalls, "");
  const fileCallCount = () => readFileSync(fileCalls, "utf8").split("\n").filter(Boolean).length;
  write(
    app + "/Contents/Info.plist",
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.openclaw.mac</string>
<key>CFBundleShortVersionString</key><string>${buildInfo.version}</string>
<key>CFBundleVersion</key><string>420</string>
<key>OpenClawGitCommit</key><string>${sourceCommit}</string>
<key>PeekabooSourceCommit</key><string>${peekabooCommit}</string>
<key>OpenClawBuildTimestamp</key><string>${buildInfo.builtAt}</string>
<key>OpenClawWorkerBuildID</key><string>${buildInfo.buildId}</string>
</dict></plist>`,
  );
  write(app + "/Contents/MacOS/OpenClaw", binaries.universal, 0o755);
  write(app + "/Contents/MacOS/openclaw-mlx-tts", binaries.universal, 0o755);
  write(app + "/Contents/Frameworks/shared [fixture].dylib", binaries.universalLibrary, 0o755);
  for (const arch of ["arm64", "x86_64"] as const) {
    const worker = path.join(app, workerRoot, arch);
    write(path.join(worker, "bin/node"), binaries[arch], 0o755);
    write(path.join(worker, workerDist, "entry.js"), "// inert package entry\n");
    write(path.join(worker, workerDist, "build-info.json"), JSON.stringify(buildInfo));
    write(path.join(worker, addon), binaries[arch === "arm64" ? "armLibrary" : "intelLibrary"]);
    write(path.join(worker, library), binaries.universalLibrary);
    write(
      path.join(worker, "lib/native.a"),
      binaries[arch === "arm64" ? "armArchive" : "intelArchive"],
    );
    symlinkSync("../lib/node_modules/openclaw/dist/entry.js", path.join(worker, "bin/openclaw"));
    symlinkSync("native [fixture]", path.join(worker, "lib/node_modules/native-alias"));
  }
  const jq = spawnSync("/bin/sh", ["-c", "command -v jq"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(jq.status, jq.stderr).toBe(0);
  symlinkSync(jq.stdout.trim(), path.join(bin, "jq"));
  const bashEnv = path.join(home, "intercepts.bash");
  write(
    bashEnv,
    `
record() { printf '%s\\n' "$*" >>"$TEST_CALLS"; }
deny() { printf '%s\\n' "$*" >>"$TEST_FORBIDDEN"; exit 97; }
shasum() {
  [[ "$1 $2" == '-a 256' && "$#" -le 3 ]] || deny unexpected-shasum
  shift 2
  if [[ -n "\${WORK_ROOT:-}" && "\${1:-}" == "$WORK_ROOT/OpenClaw.app/Contents/MacOS/OpenClaw" ]]; then record candidate-helper-hash; fi
  /usr/bin/openssl dgst -sha256 -r "$@"
}
for tool in launchctl open kill pkill killall pgrep lsof defaults diskutil sqlite3 security osascript openclaw node python python3 curl ssh; do
  eval "$tool() { deny $tool; }"
done
codesign() (
  record codesign "$@"
  target="\${!#}"
  if [[ "$*" == *--entitlements* ]]; then
    if [[ "$TEST_FAULT" == apple-events && "$target" == *'/arm64/${addon}' ||
          "$TEST_FAULT" == bundle-events && "$target" == *'/fixture.xpc' ]]; then
      printf '%s\\n' '<plist><dict><key>com.apple.security.automation.apple-events</key><true/></dict></plist>'
    elif [[ "$TEST_FAULT" == mlx && "$target" == */openclaw-mlx-tts ]]; then
      printf '%s\\n' '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>'
    else
      printf '%s\\n' '${entitlements.trim()}'
    fi
  elif [[ "$*" == *--verify* ]]; then
    if [[ "$*" == *--deep* ]]; then
      record "helper-authority=\${AUTHENTICATED_RENAME_HELPER:-}:\${AUTHENTICATED_RENAME_HELPER_SHA:-}"
    fi
    if [[ "$TEST_FAULT" == signature && "$*" == *--all-architectures* ||
          "$TEST_FAULT" == notarized && "$*" == *--test-requirement==notarized* ]]; then
      printf 'mock rejection: %s\\n' "$TEST_FAULT" >&2
      exit 23
    fi
  elif [[ "$*" == *-dv* ]]; then
    team=FWJYW4S8P8; authority='${authority}'; hash=FIXTUREARM64
    format='Mach-O universal (x86_64 arm64)'
    [[ ! -d "$target" ]] || format='app bundle with Mach-O universal (x86_64 arm64)'
    # Real raw fat64 signatures display generic; archives have no standalone signature.
    prefix=''
    if [[ -f "$target" ]]; then LC_ALL=C IFS= read -r -d '' -n 8 prefix <"$target" || true; fi
    [[ "$prefix" != $'!<arch>\\n' && "$target" != *'/lib/universal.a' && "$target" != *'/lib/archive64 [*]' ]] || exit 1
    [[ "\${prefix:0:4}" != $'\\xca\\xfe\\xba\\xbf' ]] || format=generic
    [[ "$TEST_FAULT" != archive-node || "$target" != */arm64/bin/node ]] || exit 1
    # These fixture resource kinds have no native signature, even when executable.
    if [[ "$target" == *'/lib/object-resource '* || "$TEST_FAULT" == *-node && "$target" == */arm64/bin/node ]]; then format=generic; fi
    for arch in arm64 x86_64; do
      if [[ "$*" == *"--arch $arch"* ]]; then
        [[ "$TEST_FAULT" != "team-$arch" ]] || team=WRONGTEAM
        [[ "$TEST_FAULT" != "authority-$arch" ]] || authority='Developer ID Application: Other (FWJYW4S8P8)'
        [[ "$TEST_FAULT" != "cdhash-$arch" ]] || hash=WRONGHASH
      fi
    done
    [[ "$*" != *'--arch x86_64'* || "$hash" == WRONGHASH ]] || hash=FIXTUREX8664
    for arch in arm64 x86_64; do
      if [[ "$target" == *"/$arch/${addon}" ]]; then
        [[ "$TEST_FAULT" != "generic-native-$arch" ]] || format=generic
        [[ "$TEST_FAULT" != "missing-native-format-$arch" ]] || format=''
      fi
    done
    # Filename lines cannot supply missing genuine metadata or replace wrong fields.
    printf 'Executable=%s\\nFormat=Mach-O thin (arm64)\\nCodeDirectory v=20400\\nAuthority=${authority}\\nTeamIdentifier=FWJYW4S8P8\\nIdentifier=fixture\\n' "$target" >&2
    [[ -z "$format" ]] || printf 'Format=%s\\n' "$format" >&2
    printf 'CodeDirectory v=20400 size=231 flags=0x0(none) hashes=2+2 location=embedded\\n' >&2
    printf 'Authority=%s\\nTeamIdentifier=%s\\nCDHash=%s\\n' "$authority" "$team" "$hash" >&2
  else
    deny unexpected-codesign
  fi
)
xcrun() { record xcrun "$@"; [[ "$1 $2" == 'stapler validate' ]] || deny unexpected-xcrun; [[ "$TEST_FAULT" != stapler ]] || { echo 'mock rejection: stapler' >&2; return 23; }; }
spctl() { record spctl "$@"; [[ "$1 $2 $3" == '--assess --type execute' ]] || deny unexpected-spctl; [[ "$TEST_FAULT" != spctl ]] || { echo 'mock rejection: spctl' >&2; return 23; }; }
find() {
  if [[ "$TEST_FAULT" == find-code && "$1" == *.app || "$TEST_FAULT" == find-links && "$1" == -L ]]; then
    echo 'mock rejection: find' >&2; return 23
  fi
  /usr/bin/find "$@"
}
file() {
  [[ "$TEST_FAULT" != file ]] || { echo 'mock rejection: file' >&2; return 23; }
  printf 'file\\n' >>"$TEST_FILE_CALLS"
  if [[ "$1" == -E ]]; then
    case "$TEST_FAULT" in
      file-empty) return 0 ;;
      file-missing-description) printf '%s\\0' "$7"; return 0 ;;
      file-unterminated-description) printf '%s\\0data' "$7"; return 0 ;;
      file-empty-description) printf '%s\\0\\0' "$7"; return 0 ;;
      file-mismatched-path) printf '%s\\0data\\0' "$7.wrong"; return 0 ;;
    esac
  fi
  /usr/bin/file "$@" || return $?
  case "$TEST_FAULT" in
    file-trailing-byte) printf x ;;
    file-extra-record) printf '%s\\0data\\0' unexpected ;;
    file-partial-error) return 23 ;;
    file-changed-type) /bin/rm -f "$7"; /bin/mkdir "$7" ;;
  esac
}
lipo() { [[ "$TEST_FAULT" != lipo ]] || { echo 'mock rejection: lipo' >&2; return 23; }; /usr/bin/lipo "$@"; }
plutil() {
  /usr/bin/plutil "$@" && return 0
  # macOS versions differ in which stream carries extraction diagnostics.
  [[ "$TEST_FAULT" != plist-error-stdout ]] || printf 'fixture diagnostic, not plist data\\n'
  return 1
}
`,
  );
  for (const tool of [
    "codesign",
    "xcrun",
    "spctl",
    "launchctl",
    "open",
    "security",
    "openclaw",
    "node",
    "python3",
    "curl",
    "ssh",
  ]) {
    write(
      path.join(bin, tool),
      '#!/bin/sh\nprintf "%s\\n" "forbidden PATH fallthrough" >>"$TEST_FORBIDDEN"\nexit 97\n',
      0o755,
    );
  }
  const env = {
    HOME: home,
    TMPDIR: home,
    PATH: `${bin}:${systemPath}`,
    BASH_ENV: bashEnv,
    TEST_CALLS: calls,
    TEST_FILE_CALLS: fileCalls,
    TEST_FORBIDDEN: forbidden,
    TEST_FAULT: "",
  };
  const run = (args: string[], fault = "") => {
    const result = spawnSync("/bin/bash", args, {
      cwd: home,
      encoding: "utf8",
      env: { ...env, TEST_FAULT: fault },
      timeout: 20_000,
    });
    expect(
      existsSync(forbidden),
      `verify must not invoke apps, services, secrets, or live tools: ${existsSync(forbidden) ? readFileSync(forbidden, "utf8") : ""}`,
    ).toBe(false);
    expect(result.error, `file classifier invocations: ${fileCallCount()}`).toBeUndefined();
    expect(readdirSync(home).filter((name) => name.startsWith("openclaw-elevation-code."))).toEqual(
      [],
    );
    return result;
  };
  const receipt = {
    schemaVersion: 1,
    kind: "openclaw-elevation-artifact",
    archive: path.basename(archive),
    archiveChecksum: `${path.basename(archive)}.sha256`,
    archiveSha256: "",
    installer: path.basename(installer),
    installerChecksum: `${path.basename(installer)}.sha256`,
    installerSha256: digest(readFileSync(installer)),
    sourceCommit,
    peekabooCommit,
    version: buildInfo.version,
    build: "420",
    authority,
    teamIdentifier: "FWJYW4S8P8",
    cdhashes: { arm64: "FIXTUREARM64", x86_64: "FIXTUREX8664" },
    architectures: {
      main: runMacFixtureTool("/usr/bin/lipo", ["-archs", app + "/Contents/MacOS/OpenClaw"], root),
      helper: runMacFixtureTool(
        "/usr/bin/lipo",
        ["-archs", app + "/Contents/MacOS/openclaw-mlx-tts"],
        root,
      ),
    },
    entitlementsSha256: { main: digest(entitlements), helper: digest(entitlements) },
    notarizationId: "12345678-1234-1234-1234-123456789abc",
  };
  const verify = (fault = "") => {
    rmSync(archive, { force: true });
    runMacFixtureTool("/usr/bin/ditto", ["-c", "-k", payload, archive], root);
    receipt.archiveSha256 = digest(readFileSync(archive));
    write(receiptPath, JSON.stringify(receipt));
    return run(
      [
        installer,
        "verify",
        "--archive",
        archive,
        "--receipt",
        receiptPath,
        "--receipt-sha256",
        digest(readFileSync(receiptPath)),
      ],
      fault,
    );
  };
  const verifyProgram = (program: string, fault: string) => {
    const script = readFileSync(installer, "utf8");
    // Retain actual owners and cleanup, but exclude every operational entrypoint.
    chmodSync(installer, 0o755);
    write(
      installer,
      `${script.slice(0, script.lastIndexOf("\nrefresh_runtime_paths\n"))}
prepare_authenticated_artifact_inputs "$ARTIFACT_RECEIPT" "$ARCHIVE" "\${BASH_SOURCE[0]}"
${program}`,
      0o555,
    );
    receipt.installerSha256 = digest(readFileSync(installer));
    return verify(fault);
  };
  return {
    app,
    binaries,
    home,
    receipt,
    calls,
    fileCallCount,
    at: (relative: string) => path.join(app, relative),
    verifyCode() {
      // Measure discovery independently of ZIP extraction and receipt verification;
      // full portable-artifact cases below still exercise those boundaries.
      const script = readFileSync(installer, "utf8");
      const helpers = script.slice(
        script.indexOf("plist_value() {"),
        script.indexOf("\nelevation_app_is_cua_free() {"),
      );
      const fail = script.slice(script.indexOf("fail() {"), script.indexOf("\nusage() {"));
      const verifier = path.join(home, "verify-code.bash");
      // System Bash reads BASH_ENV for a script file, but not for -c here.
      write(
        verifier,
        `set -euo pipefail\n${fail}\n${helpers}\nverify_elevation_code "$1"\nprintf 'Elevation code verified\\n'`,
      );
      return run([verifier, app]);
    },
    verifyReceiptConditionally(fault: string) {
      return verifyProgram(
        `
if verify_artifact_receipt "$AUTHENTICATED_RECEIPT_PATH" "$AUTHENTICATED_ARCHIVE_PATH" '${app.replaceAll("'", "'\\''")}' "\${BASH_SOURCE[0]}"; then
  printf 'Conditional receipt accepted\\n'
else
  exit $?
fi
`,
        fault,
      );
    },
    verifyStagedCopy(fault: string) {
      return verifyProgram(
        `
APP_PATH="$HOME/stage-destination.app"
stage_verified_app_for_install '${app.replaceAll("'", "'\\''")}' '${sourceCommit}' '${peekabooCommit}'
printf 'Staged copy verified: %s\\n' "$STAGED_INSTALL_APP_PATH"
`,
        fault,
      );
    },
    recoveryPlan(fault: string) {
      const script = readFileSync(installer, "utf8");
      const functions = (
        [
          ["fail() {", "\nusage() {"],
          ["plist_value() {", "\nelevation_plist_binds_app() {"],
          ["verify_elevation_app() {", "\nverify_rollback_app() {"],
          ["recover_host() {", "\nuninstall_host() {"],
        ] as const
      ).map(([start, end]) => script.slice(script.indexOf(start), script.indexOf(end)));
      const planner = path.join(home, "recovery-plan.bash");
      // Keep the real recovery conditional, but exit before receipt/transaction work.
      // The existing BASH_ENV still intercepts policy and denies live tools.
      write(
        planner,
        `set -euo pipefail
${functions.join("\n")}
APP_PATH="$1"
EXPECTED_BUNDLE_ID=ai.openclaw.mac
EXPECTED_TEAM_ID=FWJYW4S8P8
EXPECTED_AUTHORITY='${authority}'
durable_path_identity() { [[ "$1" == "$APP_PATH" ]] || deny unexpected-identity; printf 'fixture-identity'; }
path_matches_identity() { [[ "$1" == "$APP_PATH" && "$2" == fixture-identity ]] || deny changed-identity; record stable-recovery-identity; }
select_recovery_receipt() { printf 'Recovery planning state: %s\\n' "$RECOVERY_CURRENT_APP_STATE"; exit 0; }
verify_install_receipt() { deny recovery-receipt-work; }
recover_host
deny recovery-continued
`,
      );
      return run([planner, app], fault);
    },
    verify,
  };
}

export function registerMacElevationArtifactTests() {
  describe.skipIf(process.platform !== "darwin")(
    "portable elevation native artifact verification",
    () => {
      it("accepts a real archive with a complete native worker pair outside the checkout", () => {
        const harness = artifactFixture();
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          `Elevation artifact verified: source=${sourceCommit} peekaboo=${peekabooCommit}`,
        );
        const calls = readFileSync(harness.calls, "utf8");
        expect(
          calls.match(/^codesign --verify --deep --strict --all-architectures /gm),
        ).toHaveLength(1);
        expect(calls.match(/^helper-authority=.*$/gm)).toEqual(["helper-authority=:"]);
        expect(calls.indexOf("candidate-helper-hash")).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf("candidate-helper-hash")).toBeLessThan(
          calls.indexOf("codesign --verify --deep"),
        );
        expect(calls).toContain("codesign -dv --verbose=4 --arch arm64 ");
        expect(calls).toContain("codesign -dv --verbose=4 --arch x86_64 ");
        expect(calls).toContain("codesign --verify --strict --test-requirement==notarized ");
        expect(calls).toContain("xcrun stapler validate ");
        expect(calls).toContain("spctl --assess --type execute ");
        for (const arch of ["arm64", "x86_64"]) {
          expect(calls).toContain(`/${arch}/${addon}`);
          expect(calls).toContain(`/${arch}/${library}`);
        }
      });

      it.each(["extra-entry", "regular-file", "symlink"])(
        "rejects an archive with an invalid app root (%s) before authenticating a helper",
        (kind) => {
          const harness = artifactFixture();
          if (kind === "extra-entry") {
            write(path.join(path.dirname(harness.app), "unexpected"), "not app content\n");
          } else {
            const reference = path.join(harness.home, "reference.app");
            renameSync(harness.app, reference);
            if (kind === "symlink") {
              symlinkSync(reference, harness.app);
            } else {
              write(harness.app, "not an app directory\n");
            }
          }
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation archive root");
          expect(result.stdout).not.toContain("Elevation artifact verified");
          const calls = readFileSync(harness.calls, "utf8");
          expect(calls).not.toContain("candidate-helper-hash");
          expect(calls).not.toContain("codesign --verify");
        },
      );

      it("accepts universal worker slices and contained terminal symlinks", () => {
        const harness = artifactFixture();
        for (const arch of ["arm64", "x86_64"]) {
          const node = harness.at(`${workerRoot}/${arch}/bin/node`);
          renameSync(node, `${node}-real\n`);
          write(`${node}-real\n`, harness.binaries.universal, 0o755);
          symlinkSync("node-real\n", node);
        }
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Elevation artifact verified");
      });

      it("batches native classification across resource-heavy worker trees", () => {
        const harness = artifactFixture();
        for (const arch of ["arm64", "x86_64"]) {
          for (let index = 0; index < 40; index++) {
            write(
              harness.at(`${workerRoot}/${arch}/nested/win32/resource [*]?\n${index}.js`),
              `// harmless platform resource ${index}\n`,
            );
          }
        }
        const result = harness.verifyCode();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("Elevation code verified\n");
        const count = harness.fileCallCount();
        console.info(`portable verifier: 80 resources, ${count} file classifier invocations`);
        // Allow different batch sizes, but never one process per resource.
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(12);
        for (const arch of ["arm64", "x86_64"]) {
          expect(readFileSync(harness.calls, "utf8")).toContain(`/${arch}/${addon}`);
        }
      });

      it.each([
        ["shared", "Contents/Frameworks/shared [fixture].dylib", "arm64", 0o755, false],
        ["arm64 addon", `${workerRoot}/arm64/${addon}`, "x86_64", 0o644, false],
        ["x86_64 addon", `${workerRoot}/x86_64/${addon}`, "arm64", 0o644, false],
        ["arm64 archive", `${workerRoot}/arm64/lib/native.a`, "x86_64", 0o644, true],
        ["x86_64 archive", `${workerRoot}/x86_64/lib/native.a`, "arm64", 0o644, true],
      ] as const)(
        "rejects wrong fat64 slices in %s code",
        (_name, relative, arch, mode, archive) => {
          const harness = artifactFixture();
          const bytes = archive
            ? macFatContainerFixture(
                harness.home,
                [harness.binaries[arch === "arm64" ? "armArchive" : "intelArchive"]],
                true,
              )
            : singleSliceMacFat64(harness.home, arch);
          write(harness.at(relative), bytes, mode);
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(
            relative.startsWith(workerRoot)
              ? `elevation worker Mach-O lacks ${arch === "arm64" ? "x86_64" : "arm64"}:`
              : "elevation Mach-O is not universal:",
          );
          expect(result.stderr).toContain(relative);
        },
      );

      it.each(["Contents/Frameworks/shared [fixture].dylib", `${workerRoot}/arm64/${addon}`])(
        "rejects malformed fat64 code at %s",
        (relative) => {
          const harness = artifactFixture();
          write(harness.at(relative), Buffer.from("cafebabf", "hex"), 0o755);
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("could not inspect elevation code slices:");
          expect(result.stderr).toContain(relative);
        },
      );

      it.each(
        ["arm64", "x86_64"].flatMap((arch) => [
          `generic-native-${arch}`,
          `missing-native-format-${arch}`,
        ]),
      )("rejects %s signatures despite successful app policy verification", (fault) => {
        const harness = artifactFixture();
        const result = harness.verify(fault);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation code lacks native signature format:");
        expect(result.stderr).toContain(addon);
        expect(readFileSync(harness.calls, "utf8")).toContain("spctl --assess --type execute");
      });

      it.each([
        ["Contents/MacOS/OpenClaw", false],
        [`${workerRoot}/arm64/${addon}`, true],
      ] as const)("rejects generic raw-fat64 signatures at %s", (relative, libraryImage) => {
        const harness = artifactFixture();
        const bytes = libraryImage
          ? macFatContainerFixture(
              harness.home,
              [harness.binaries.armLibrary, harness.binaries.intelLibrary],
              true,
            )
          : harness.binaries.fat64;
        write(harness.at(relative), bytes, libraryImage ? 0o644 : 0o755);
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation code lacks native signature format:");
        expect(result.stderr).toContain(relative);
      });

      it.each(
        (["archive", ...machResourceKinds] as const).flatMap((resource) =>
          [false, true].flatMap((fat64) =>
            [false, true].map((archiveFirst) => ({ resource, fat64, archiveFirst })),
          ),
        ),
      )(
        "rejects mixed $resource/native containers (fat64=$fat64, archiveFirst=$archiveFirst)",
        ({ resource, fat64, archiveFirst }) => {
          const harness = artifactFixture();
          const armResource =
            resource === "archive"
              ? harness.binaries.armArchive
              : macObjectFixture(harness.home, "arm64");
          const intelResource =
            resource === "archive"
              ? harness.binaries.intelArchive
              : macObjectFixture(harness.home, "x86_64");
          const mixed = macFatContainerFixture(
            harness.home,
            archiveFirst
              ? [harness.binaries.armLibrary, intelResource]
              : [armResource, harness.binaries.intelLibrary],
            fat64,
          );
          write(harness.at(`${workerRoot}/arm64/${addon}`), withMachResourceKind(mixed, resource));
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(
            `mixed ${resource === "archive" ? "archive" : "resource"}/native elevation code:`,
          );
        },
      );

      it("rejects a malformed sibling slice in an otherwise compatible fat container", () => {
        const harness = artifactFixture();
        const bytes = Buffer.from(harness.binaries.universalArchive);
        expect(bytes.readUInt32BE(0)).toBe(0xcafebabe);
        expect(bytes.readUInt32BE(8)).toBe(0x01000007); // x86_64 comes first in lipo output.
        bytes.fill(0, bytes.readUInt32BE(16), bytes.readUInt32BE(16) + 8);
        write(harness.at(`${workerRoot}/arm64/${addon}`), bytes);
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("invalid elevation code slice:");
        expect(result.stderr).toContain(`${workerRoot}/arm64/${addon} (x86_64)`);
        expect(result.stdout).not.toContain("Elevation artifact verified");
      });

      it.each(
        (["archive", ...machResourceKinds] as const).flatMap((resource) =>
          ["thin", "fat32", "fat64"].map((format) => ({ resource, format })),
        ),
      )("rejects $resource resources posing as Node ($format)", ({ resource, format }) => {
        const harness = artifactFixture();
        const arm =
          resource === "archive"
            ? harness.binaries.armArchive
            : macObjectFixture(harness.home, "arm64");
        const intel =
          resource === "archive"
            ? harness.binaries.intelArchive
            : macObjectFixture(harness.home, "x86_64");
        const bytes =
          format !== "thin"
            ? macFatContainerFixture(harness.home, [arm, intel], format === "fat64")
            : arm;
        write(
          harness.at(`${workerRoot}/arm64/bin/node`),
          withMachResourceKind(bytes, resource),
          0o755,
        );
        const result = harness.verify(`${resource}-node`);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).not.toContain("Elevation artifact verified");
        expect(result.stderr).toContain(
          resource === "archive" ? "elevation worker Node must be Mach-O:" : "/arm64/bin/node",
        );
      });

      it.each(
        machResourceKinds.flatMap((resource) =>
          ["thin", "fat32", "fat64"].map((format) => ({ resource, format })),
        ),
      )(
        "accepts $format $resource resources without changing bytes or modes",
        ({ resource, format }) => {
          const harness = artifactFixture();
          const objects = {
            arm64: macObjectFixture(harness.home, "arm64"),
            x86_64: macObjectFixture(harness.home, "x86_64"),
          };
          const universal =
            format === "thin"
              ? undefined
              : macFatContainerFixture(
                  harness.home,
                  [objects.arm64, objects.x86_64],
                  format === "fat64",
                );
          const preserved = [];
          for (const arch of ["arm64", "x86_64"] as const) {
            for (const mode of [0o644, 0o755]) {
              const target = harness.at(
                `${workerRoot}/${arch}/lib/object-resource [*]\n${mode}.dylib`,
              );
              const bytes = withMachResourceKind(universal ?? objects[arch], resource);
              write(target, bytes, mode);
              preserved.push({ target, bytes, mode });
            }
          }
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Elevation artifact verified");
          const inspected = harness.verifyCode();
          expect(inspected.status, inspected.stderr).toBe(0);
          for (const { target, bytes, mode } of preserved) {
            expect(readFileSync(target), target).toEqual(bytes);
            expect(statSync(target).mode & 0o777, target).toBe(mode);
          }
          const calls = readFileSync(harness.calls, "utf8");
          expect(calls).toContain("codesign --verify --deep --strict --all-architectures");
          expect(
            calls
              .split("\n")
              .filter(
                (line) =>
                  line.startsWith("codesign -dv --verbose=4") && line.includes("object-resource"),
              ),
          ).toEqual([]);
        },
      );

      it.each(
        ["arm64", "x86_64"].flatMap((arch) =>
          ["thin", "fat32", "fat64"].map((format) => ({ arch, format })),
        ),
      )("rejects wrong-architecture $format object resources in $arch", ({ arch, format }) => {
        const harness = artifactFixture();
        const wrong = macObjectFixture(harness.home, arch === "arm64" ? "x86_64" : "arm64");
        const bytes =
          format === "thin"
            ? wrong
            : macFatContainerFixture(harness.home, [wrong], format === "fat64");
        // lipo -info repeats the path: injected architecture text is still a filename.
        const relative = `${workerRoot}/${arch}/lib/object-resource are: arm64 x86_64\nNon-fat file: injected is architecture: ${arch}`;
        write(harness.at(relative), bytes);
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(`elevation worker Mach-O lacks ${arch}:`);
        expect(result.stderr).toContain(relative);
      });

      it.each(
        ["arm64", "x86_64"].flatMap((arch) =>
          ["empty", "missing-member"].map((kind) => ({ arch, kind })),
        ),
      )("rejects $kind GNU thin archives in $arch", ({ arch, kind }) => {
        const harness = artifactFixture();
        const header = [
          "missing.o/".padEnd(16),
          "0".padEnd(12),
          "0".padEnd(6),
          "0".padEnd(6),
          "100644".padEnd(8),
          "0".padEnd(10),
          "`\n",
        ].join("");
        const target = harness.at(`${workerRoot}/${arch}/lib/opaque [*].resource`);
        write(target, `!<thin>\n${kind === "empty" ? "" : header}`);
        expect(runMacFixtureTool("/usr/bin/file", ["-b", target], harness.home)).toContain(
          "thin archive with",
        );
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation worker contains unsupported thin archive:");
        expect(result.stdout).not.toContain("Elevation artifact verified");
      });

      it("accepts universal native code, static archives, tar and Java resources without changing bytes or modes", () => {
        const harness = artifactFixture();
        write(path.join(harness.home, "ordinary.txt"), "ordinary resource\n");
        const tar = path.join(harness.home, "ordinary.tar");
        runMacFixtureTool(
          "/usr/bin/tar",
          ["--format", "ustar", "-cf", tar, "-C", harness.home, "ordinary.txt"],
          harness.home,
        );
        expect(runMacFixtureTool("/usr/bin/file", ["-b", tar], harness.home)).toBe(
          "POSIX tar archive",
        );
        const targets = [
          "Contents/Frameworks/shared [fixture].dylib",
          ...["arm64", "x86_64"].flatMap((arch) => [
            `${workerRoot}/${arch}/bin/node`,
            `${workerRoot}/${arch}/${addon}`,
          ]),
        ];
        for (const relative of targets) {
          write(
            harness.at(relative),
            harness.binaries.universal,
            relative.endsWith(addon) ? 0o644 : 0o755,
          );
        }
        // Shared slice enforcement retains find -perm -111 semantics, not just -x.
        for (const mode of [0o644, 0o700, 0o750]) {
          write(
            harness.at(`Contents/Frameworks/thin-${mode}.dylib`),
            harness.binaries.armLibrary,
            mode,
          );
        }
        const archive64 = macFatContainerFixture(
          harness.home,
          [harness.binaries.armArchive, harness.binaries.intelArchive],
          true,
        );
        for (const arch of ["arm64", "x86_64"]) {
          write(harness.at(`${workerRoot}/${arch}/ordinary.resource`), readFileSync(tar));
          write(
            harness.at(`${workerRoot}/${arch}/lib/universal.a`),
            harness.binaries.universalArchive,
          );
          write(harness.at(`${workerRoot}/${arch}/lib/archive64 [*]`), archive64);
          write(
            harness.at(`${workerRoot}/${arch}/Example.class`),
            Buffer.from("cafebabe0000003400010001000000000000000000000000", "hex"),
          );
        }
        const preserved = [
          ...targets,
          "Contents/MacOS/OpenClaw",
          "Contents/MacOS/openclaw-mlx-tts",
          ...[0o644, 0o700, 0o750].map((mode) => `Contents/Frameworks/thin-${mode}.dylib`),
          ...["arm64", "x86_64"].flatMap((arch) =>
            [
              library,
              "lib/native.a",
              "lib/universal.a",
              "lib/archive64 [*]",
              "Example.class",
              "ordinary.resource",
            ].map((relative) => `${workerRoot}/${arch}/${relative}`),
          ),
        ].map((relative) => ({
          relative,
          bytes: readFileSync(harness.at(relative)),
          mode: statSync(harness.at(relative)).mode & 0o777,
        }));
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Elevation artifact verified");
        // verifyCode receives this tree; verify above inspects a separate ZIP extraction.
        const code = harness.verifyCode();
        expect(code.status, code.stderr).toBe(0);
        expect(code.stdout).toBe("Elevation code verified\n");
        for (const { relative, bytes, mode } of preserved) {
          expect(readFileSync(harness.at(relative)), relative).toEqual(bytes);
          expect(statSync(harness.at(relative)).mode & 0o777, relative).toBe(mode);
        }
      });

      it.each(
        (
          [
            ["Contents", "contents"],
            ["Contents/Resources", "Contents/resources"],
            [workerRoot, "Contents/Resources/Node-Worker"],
          ] as const
        ).flatMap(([relative, alias]) =>
          ["wrong-slice", "escaping-link"].map((fault) => ({ relative, alias, fault })),
        ),
      )(
        "rejects case-aliased worker structure $relative ($fault)",
        ({ relative, alias, fault }) => {
          const harness = artifactFixture();
          for (const arch of ["arm64", "x86_64"]) {
            write(harness.at(`${workerRoot}/${arch}/bin/node`), harness.binaries.universal, 0o755);
          }
          const target = harness.at(`${workerRoot}/arm64/${addon}`);
          if (fault === "wrong-slice") {
            write(target, harness.binaries.intelLibrary);
          } else {
            const outside = path.join(harness.home, "outside-addon");
            renameSync(target, outside);
            symlinkSync(outside, target);
          }
          renameSync(harness.at(relative), harness.at(alias));
          expect(readdirSync(path.dirname(harness.at(alias)))).toContain(path.basename(alias));
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("canonical directory spelling required");
        },
      );

      it.each([
        ["both workers", workerRoot],
        ["arm64 worker", `${workerRoot}/arm64`],
        ["x86_64 worker", `${workerRoot}/x86_64`],
      ])("rejects missing %s", (_name, relative) => {
        const harness = artifactFixture();
        rmSync(harness.at(relative), { recursive: true });
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation worker directory missing or symlinked:");
      });

      it.each(["arm64", "x86_64"] as const)(
        "rejects wrong slices throughout the %s worker",
        (arch) => {
          const harness = artifactFixture();
          const wrongArch = arch === "arm64" ? "x86_64" : "arm64";
          const cases = [
            ["bin/node", harness.binaries[wrongArch], 0o755],
            [addon, harness.binaries[arch === "arm64" ? "intelLibrary" : "armLibrary"], 0o644],
            [library, harness.binaries[arch === "arm64" ? "intelLibrary" : "armLibrary"], 0o644],
            [
              "lib/native.a",
              harness.binaries[arch === "arm64" ? "intelArchive" : "armArchive"],
              0o644,
            ],
            ["lib/space [glob]*\naddon.node", harness.binaries[wrongArch], 0o644],
          ] as const;
          for (const [relative, contents, mode] of cases) {
            const target = harness.at(`${workerRoot}/${arch}/${relative}`);
            const original = existsSync(target) ? readFileSync(target) : undefined;
            write(target, contents, mode);
            const result = harness.verify();
            expect(result.status, `${relative}: ${result.stderr}`).toBe(1);
            expect(result.stderr).toContain(`elevation worker Mach-O lacks ${arch}:`);
            expect(result.stderr).toContain(relative);
            if (original) {
              write(target, original, mode);
            } else {
              rmSync(target);
            }
          }
        },
      );

      it.each(["bin/node", `${workerDist}/entry.js`, `${workerDist}/build-info.json`])(
        "rejects an incomplete worker missing %s",
        (relative) => {
          const harness = artifactFixture();
          rmSync(harness.at(`${workerRoot}/x86_64/${relative}`));
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          // The npm-style entrypoint link must also remain valid when its target disappears.
          expect(result.stderr).toMatch(
            /elevation worker payload is incomplete|broken or cyclic elevation worker symlink/,
          );
        },
      );

      it.each(["version", "commit", "builtAt", "buildId"] as const)(
        "rejects mismatched worker %s",
        (key) => {
          const harness = artifactFixture();
          write(
            harness.at(`${workerRoot}/x86_64/${workerDist}/build-info.json`),
            JSON.stringify({ ...buildInfo, [key]: "wrong" }),
          );
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation worker build metadata does not match app:");
          expect(result.stderr).toContain("/x86_64");
        },
      );

      it("rejects missing app build identity and executable non-Mach-O Node", () => {
        const harness = artifactFixture();
        const node = harness.at(`${workerRoot}/arm64/bin/node`);
        write(node, "#!/bin/sh\nexit 97\n", 0o755);
        const nonNative = harness.verify();
        expect(nonNative.status, nonNative.stderr).toBe(1);
        expect(nonNative.stderr).toContain("elevation worker Node must be Mach-O:");
        write(node, harness.binaries.arm64, 0o755);
        runMacFixtureTool(
          "/usr/bin/plutil",
          ["-remove", "OpenClawWorkerBuildID", harness.at("Contents/Info.plist")],
          harness.home,
        );
        const missingIdentity = harness.verify("plist-error-stdout");
        expect(missingIdentity.status, missingIdentity.stderr).toBe(1);
        expect(missingIdentity.stderr).toContain("elevation app is missing worker build identity");
      });

      it.each(["directory", "file", "symlink"])(
        "rejects an unexpected worker architecture %s",
        (kind) => {
          const harness = artifactFixture();
          const extra = harness.at(`${workerRoot}/unexpected [arch]`);
          if (kind === "directory") {
            mkdirSync(extra);
          } else if (kind === "symlink") {
            symlinkSync("arm64", extra);
          } else {
            write(extra, "unexpected");
          }
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("unexpected elevation worker architecture entry:");
        },
      );

      it.each([
        "Contents",
        "Contents/Resources",
        workerRoot,
        `${workerRoot}/arm64`,
        `${workerRoot}/arm64/bin`,
        `${workerRoot}/arm64/lib/node_modules/openclaw`,
        `${workerRoot}/arm64/bin/node`,
        `${workerRoot}/arm64/${workerDist}/entry.js`,
        `${workerRoot}/arm64/${workerDist}/build-info.json`,
        `${workerRoot}/arm64/${addon}`,
      ])("rejects an escaping root, intermediate, or terminal link at %s", (relative) => {
        const harness = artifactFixture();
        const target = harness.at(relative);
        const outside = path.join(harness.home, "outside-worker");
        renameSync(target, outside);
        symlinkSync(outside, target);
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toMatch(
          /elevation worker directory missing or symlinked|elevation worker symlink escapes its architecture tree/,
        );
      });

      it.each([
        "dangling",
        "terminal-cycle",
        "directory-cycle",
        "indirect-directory-cycle",
        "cross-worker",
      ])("rejects %s worker links", (kind) => {
        const harness = artifactFixture();
        const worker = harness.at(`${workerRoot}/arm64`);
        if (kind === "directory-cycle") {
          symlinkSync(".", path.join(worker, "loop"));
        } else if (kind === "indirect-directory-cycle") {
          mkdirSync(path.join(worker, "a"));
          mkdirSync(path.join(worker, "b"));
          symlinkSync("../b", path.join(worker, "a/to-b"));
          symlinkSync("../a", path.join(worker, "b/to-a"));
        } else if (kind === "cross-worker") {
          symlinkSync("../x86_64", path.join(worker, "other-worker"));
        } else {
          const node = path.join(worker, "bin/node");
          rmSync(node);
          symlinkSync(kind === "dangling" ? "missing" : "node", node);
        }
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          kind.endsWith("directory-cycle")
            ? "cyclic or unreadable elevation worker tree"
            : kind === "cross-worker"
              ? "elevation worker symlink escapes its architecture tree"
              : "broken or cyclic elevation worker symlink",
        );
      });

      it.each([
        "Contents/MacOS/OpenClaw",
        "Contents/MacOS/openclaw-mlx-tts",
        "Contents/Frameworks/shared [fixture].dylib",
      ])("rejects thin shared code at %s", (relative) => {
        const harness = artifactFixture();
        write(
          harness.at(relative),
          relative.endsWith(".dylib") ? harness.binaries.armLibrary : harness.binaries.x86_64,
          0o755,
        );
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation Mach-O is not universal:");
        expect(result.stderr).toContain(relative);
      });

      it.each([
        [
          "team-arm64",
          1,
          "must be signed for every architecture",
          "codesign -dv --verbose=4 --arch arm64",
        ],
        [
          "team-x86_64",
          1,
          "must be signed for every architecture",
          "codesign -dv --verbose=4 --arch x86_64",
        ],
        [
          "authority-arm64",
          1,
          "must be signed for every architecture",
          "codesign -dv --verbose=4 --arch arm64",
        ],
        [
          "authority-x86_64",
          1,
          "must be signed for every architecture",
          "codesign -dv --verbose=4 --arch x86_64",
        ],
        [
          "signature",
          1,
          "must be signed for every architecture",
          "codesign --verify --deep --strict --all-architectures",
        ],
        [
          "notarized",
          23,
          "mock rejection: notarized",
          "codesign --verify --strict --test-requirement==notarized",
        ],
        ["stapler", 23, "mock rejection: stapler", "xcrun stapler validate"],
        ["spctl", 23, "mock rejection: spctl", "spctl --assess --type execute"],
        [
          "apple-events",
          1,
          "Apple Events entitlement remains on elevation code:",
          `/arm64/${addon}`,
        ],
        [
          "bundle-events",
          1,
          "Apple Events entitlement remains on elevation bundle:",
          "/fixture.xpc",
        ],
        [
          "mlx",
          1,
          "MLX helper must be signed without app entitlements:",
          "/Contents/MacOS/openclaw-mlx-tts",
        ],
        [
          "cdhash-arm64",
          1,
          "artifact receipt arm64 CDHash mismatch",
          "codesign -dv --verbose=4 --arch arm64",
        ],
        [
          "cdhash-x86_64",
          1,
          "artifact receipt x86_64 CDHash mismatch",
          "codesign -dv --verbose=4 --arch x86_64",
        ],
      ] as const)(
        "preserves the %s policy gate with observable mocks",
        (fault, code, diagnostic, command) => {
          const harness = artifactFixture();
          mkdirSync(harness.at(`${workerRoot}/arm64/fixture.xpc`));
          const result = harness.verify(fault);
          expect(result.status, result.stderr).toBe(code);
          expect(result.stderr).toContain(diagnostic);
          expect(readFileSync(harness.calls, "utf8")).toContain(command);
          expect(result.stdout).not.toContain("Elevation artifact verified");
        },
      );

      it.each([
        ["find-code", "could not scan elevation code"],
        ["find-links", "cyclic or unreadable elevation worker tree"],
        ["file", "could not inspect elevation code:"],
        ["file-empty", "invalid elevation code classification:"],
        ["file-missing-description", "invalid elevation code classification:"],
        ["file-unterminated-description", "invalid elevation code classification:"],
        ["file-empty-description", "invalid elevation code classification:"],
        ["file-mismatched-path", "invalid elevation code classification:"],
        ["file-trailing-byte", "unexpected trailing elevation code classification"],
        ["file-extra-record", "unexpected trailing elevation code classification"],
        ["file-partial-error", "could not inspect elevation code:"],
        ["file-changed-type", "elevation code changed type during classification:"],
        ["lipo", "could not inspect elevation code slices:"],
      ])("fails closed when %s cannot scan the artifact", (fault, diagnostic) => {
        const harness = artifactFixture();
        const result = harness.verify(fault);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).not.toContain("Elevation artifact verified");
      });

      it.each(["file", "symlink"])("preserves CUA omission for a driver %s", (kind) => {
        const harness = artifactFixture();
        const driver = harness.at("Contents/Resources/cua-driver");
        if (kind === "file") {
          write(driver, "inert driver");
        } else {
          symlinkSync("missing-driver", driver);
        }
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("elevation app must not contain bundled CUA driver:");
      });
      it.each(["{", `${JSON.stringify(buildInfo)}\n${JSON.stringify(buildInfo)}`])(
        "rejects noncanonical build metadata %s",
        (metadata) => {
          const harness = artifactFixture();
          write(harness.at(`${workerRoot}/arm64/${workerDist}/build-info.json`), metadata);
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation worker build metadata does not match app:");
        },
      );

      it.each(["healthy", "signature", "notarized", "stapler", "spctl"])(
        "fully verifies a new destination-stage copy with %s policy",
        (fault) => {
          const harness = artifactFixture();
          const result = harness.verifyStagedCopy(fault);
          expect(result.status, result.stderr).toBe(
            fault === "healthy" ? 0 : fault === "signature" ? 1 : 23,
          );
          const checks = readFileSync(harness.calls, "utf8")
            .split("\n")
            .filter((line) =>
              line.startsWith("codesign --verify --deep --strict --all-architectures "),
            );
          expect(checks).toHaveLength(1);
          expect(checks[0]).toContain(`${harness.home}/stage-destination.app.incoming-`);
          expect(
            readdirSync(harness.home).filter((name) =>
              name.startsWith("stage-destination.app.incoming-"),
            ),
          ).toEqual([]);
          if (fault === "healthy") {
            expect(result.stdout).toContain("Staged copy verified:");
          } else {
            expect(result.stdout).not.toContain("Staged copy verified:");
          }
        },
      );

      it.each([
        ["sourceCommit", "OpenClaw source"],
        ["peekabooCommit", "Peekaboo source"],
        ["version", "version"],
        ["build", "build"],
        ["authority", "signing authority"],
        ["teamIdentifier", "TeamIdentifier"],
      ] as const)("binds receipt %s to the fully audited app", (key, diagnostic) => {
        const harness = artifactFixture();
        harness.receipt[key] = "wrong";
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(`artifact receipt ${diagnostic} mismatch`);
        expect(result.stdout).not.toContain("Elevation artifact verified");
        expect(readFileSync(harness.calls, "utf8")).toContain("spctl --assess --type execute");
      });

      it.each(
        (["architectures", "entitlementsSha256"] as const).flatMap((field) =>
          (["main", "helper"] as const).map((target) => ({ field, target })),
        ),
      )("binds receipt $field for $target to the fully audited app", ({ field, target }) => {
        const harness = artifactFixture();
        harness.receipt[field][target] = "wrong";
        const result = harness.verify();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          `artifact receipt ${target} ${field === "architectures" ? "architecture" : "entitlement"} mismatch`,
        );
        expect(result.stdout).not.toContain("Elevation artifact verified");
      });

      it.each(["notarized", "stapler", "spctl"])(
        "propagates %s failure through conditional receipt verification",
        (fault) => {
          const harness = artifactFixture();
          const result = harness.verifyReceiptConditionally(fault);
          expect(result.status, result.stderr).toBe(23);
          expect(result.stderr).toContain(`mock rejection: ${fault}`);
          expect(result.stdout).not.toContain("Conditional receipt accepted");
        },
      );

      it.each([
        ["healthy", "valid", "spctl --assess --type execute"],
        ["notarized", "damaged", "codesign --verify --strict --test-requirement==notarized"],
        ["stapler", "damaged", "xcrun stapler validate"],
        ["spctl", "damaged", "spctl --assess --type execute"],
      ])("classifies recovery planning after %s policy result", (fault, state, command) => {
        const harness = artifactFixture();
        const result = harness.recoveryPlan(fault);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`Recovery planning state: ${state}\n`);
        const calls = readFileSync(harness.calls, "utf8");
        expect(calls).toContain(command);
        expect(calls).toContain("stable-recovery-identity");
      });

      it.each(["elf", "pe", "coff"] as const)(
        "rejects foreign %s worker assets even without executable bits",
        (format) => {
          const harness = artifactFixture();
          write(harness.at(`${workerRoot}/arm64/${addon}`), harness.binaries[format]);
          const result = harness.verify();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("elevation worker contains non-Mach-O native code:");
        },
      );
    },
  );
}
