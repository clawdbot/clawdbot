import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import {
  compiledMacNativeFixtures,
  runMacFixtureTool,
} from "./mac-native-fixtures.test-support.js";
import type { MacScriptFixture } from "./mac-script-fixture.test-support.js";

export const sourceCommit = "a".repeat(40);
export const peekabooCommit = "b".repeat(40);
export const buildInfo = {
  version: "4.2.0",
  commit: sourceCommit,
  builtAt: "2026-08-28T00:00:00Z",
  buildId: "fixture-build",
};
const authority = "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)";
const entitlements = "<plist><dict/></plist>\n";
export const workerRoot = "Contents/Resources/node-worker";
export const workerDist = "lib/node_modules/openclaw/dist";
export const addon = "lib/node_modules/native [fixture]/addon.node";
// Universal file output repeats the path; names must not choose the binary format.
export const library = "lib/node_modules/native [fixture]/library ERROR COFF.dylib";
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function digest(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

export function write(file: string, contents: string | Buffer, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, mode);
}

export function artifactFixture(mac: MacScriptFixture) {
  const root = mac.createTempDir("openclaw-elevation-native-");
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
  const run = async (args: string[], fault = "") => {
    const result = await mac.run("/bin/bash", args, {
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
