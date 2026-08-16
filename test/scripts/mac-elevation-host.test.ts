import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// Mac Elevation Host tests protect the unattended launchd and artifact contracts.
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
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/mac-elevation-host.sh";
const codesignScriptPath = "scripts/codesign-mac-app.sh";

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function receiptDigestArgs(receiptPath: string): string[] {
  return ["--receipt-sha256", sha256(readFileSync(receiptPath))];
}

function runInstaller(
  installerPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
) {
  return spawnSync("/bin/bash", [installerPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

function writeAppInfoPlist(appPath: string, sourceCommit: string, peekabooCommit: string): void {
  mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    path.join(appPath, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "<key>CFBundleIdentifier</key><string>ai.openclaw.mac</string>",
      `<key>OpenClawGitCommit</key><string>${sourceCommit}</string>`,
      `<key>PeekabooSourceCommit</key><string>${peekabooCommit}</string>`,
      "<key>CFBundleShortVersionString</key><string>4.2.0</string>",
      "<key>CFBundleVersion</key><string>420</string>",
      "</dict></plist>",
      "",
    ].join("\n"),
    "utf8",
  );
}

function createStatusHarness(permissionMode: "fail" | "invalid") {
  const tempRoot = tempDirs.make(`openclaw-elevation-status-${permissionMode}-`);
  const binDir = path.join(tempRoot, "bin");
  const appPath = path.join(tempRoot, "OpenClaw.app");
  const stateDir = path.join(tempRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const launchAgentsDir = path.join(tempRoot, "Library", "LaunchAgents");
  mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture", "utf8");
  writeFileSync(configPath, "{}\n", "utf8");
  writeFileSync(
    path.join(launchAgentsDir, "ai.openclaw.mac.elevation-host.plist"),
    "fixture",
    "utf8",
  );
  writeFileSync(
    path.join(stateDir, "elevation-host-install.json"),
    JSON.stringify({
      schemaVersion: 2,
      kind: "openclaw-elevation-install",
      sourceCommit: "0".repeat(40),
      peekabooCommit: `${"0".repeat(39)}1`,
      archiveSha256: "a".repeat(64),
      artifactReceiptSha256: "b".repeat(64),
      installerSha256: "c".repeat(64),
      cdhash: "TESTCDHASH",
      nodeId: "fixture-node",
      nodeProfile: "primary",
      appPath,
      stateDir,
      configPath,
      backupPath: "",
      backupCDHash: "",
      plistPath: path.join(launchAgentsDir, "ai.openclaw.mac.elevation-host.plist"),
      previousPlist: "",
      previousPlistSha256: "",
      previousPlistWasLoaded: false,
      previousReceipt: "",
      previousReceiptSha256: "",
      migration: null,
      adoptedApp: { wasRunning: false, attachOnly: false },
    }),
    "utf8",
  );

  writeExecutable(
    path.join(binDir, "codesign"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'target="${!#}"',
      'if [[ "$*" == *"--verify"* && -e "$target/Contents/invalid-signature" ]]; then',
      "  exit 1",
      "fi",
      'if [[ "$*" == *"--entitlements"* ]]; then',
      "  printf '%s\\n' '<plist><dict/></plist>'",
      "  exit 0",
      "fi",
      'if [[ "$*" == *"-dv"* ]]; then',
      "  printf '%s\\n' 'Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' >&2",
      "  printf '%s\\n' 'TeamIdentifier=FWJYW4S8P8' >&2",
      "  printf '%s\\n' 'CDHash=TESTCDHASH' >&2",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "launchctl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "print" && "${2:-}" == */ai.openclaw.mac.elevation-host ]]; then',
      "  printf '%s\\n' '    pid = 4242'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "plutil"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "${2:-}" in',
      "  CFBundleIdentifier) printf '%s\\n' 'ai.openclaw.mac' ;;",
      "  OpenClawGitCommit) printf '%040d\\n' 0 ;;",
      "  PeekabooSourceCommit) printf '%040d\\n' 1 ;;",
      "  CFBundleShortVersionString) printf '%s\\n' '4.2.0' ;;",
      '  ProgramArguments) printf \'["%s/Contents/MacOS/OpenClaw","--elevation-host"]\\n\' "$TEST_APP_PATH" ;;',
      "  EnvironmentVariables.OPENCLAW_STATE_DIR) printf '%s\\n' \"$TEST_STATE_DIR\" ;;",
      "  EnvironmentVariables.OPENCLAW_CONFIG_PATH) printf '%s\\n' \"$TEST_CONFIG_PATH\" ;;",
      "  RunAtLoad|KeepAlive) printf '%s\\n' 'true' ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(path.join(binDir, "lipo"), "#!/bin/sh\nprintf '%s\\n' 'x86_64 arm64'\n");
  writeExecutable(path.join(binDir, "pgrep"), "#!/bin/sh\nexit 1\n");
  writeExecutable(path.join(binDir, "spctl"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(binDir, "xcrun"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    path.join(binDir, "openclaw"),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"nodes":[{"nodeId":"fixture-node","connected":true,"connectedAtMs":20,"clientId":"openclaw-macos","clientMode":"node","uiVersion":"4.2.0","caps":["computer"],"commands":["screen.snapshot","computer.act"],"computerUse":{"version":2}}]}\'\n',
  );
  writeExecutable(
    path.join(binDir, "peekaboo"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "bridge" ]]; then',
      '  printf \'%s\\n\' \'{"success":true,"data":{"selected":{"handshake":{"hostIdentity":{"processIdentifier":4242}}}}}\'',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "permissions" ]]; then',
      '  if [[ "$TEST_PEEKABOO_MODE" == "fail" ]]; then exit 7; fi',
      "  printf '%s\\n' '{not-json'",
      "  exit 0",
      "fi",
      "exit 2",
      "",
    ].join("\n"),
  );

  return {
    appPath,
    stateDir,
    env: {
      ...process.env,
      HOME: tempRoot,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TEST_APP_PATH: appPath,
      TEST_CONFIG_PATH: configPath,
      TEST_STATE_DIR: stateDir,
      TEST_PEEKABOO_MODE: permissionMode,
    },
  };
}

function createMigrationPlanHarness(launchState: "absent" | "error" | "loaded" = "absent") {
  const tempRoot = tempDirs.make(`openclaw-elevation-migration-${launchState}-`);
  const binDir = path.join(tempRoot, "bin");
  const launchAgentsDir = path.join(tempRoot, "Library", "LaunchAgents");
  const appPath = path.join(tempRoot, "OpenClaw.app");
  const stateDir = path.join(tempRoot, "node-state");
  const configPath = path.join(stateDir, "openclaw.json");
  const label = "ai.openclaw.mac.node-fixture";
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  mkdirSync(binDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(stateDir, "state"), { recursive: true });
  writeFileSync(configPath, "{}\n", "utf8");
  writeFileSync(path.join(stateDir, "state", "openclaw.sqlite"), "fixture", "utf8");
  writeFileSync(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      `<key>Label</key><string>${label}</string>`,
      "<key>ProgramArguments</key><array>",
      `<string>${appPath}/Contents/MacOS/OpenClaw</string>`,
      "<string>--attach-only</string><string>--background-only</string>",
      "</array>",
      "<key>EnvironmentVariables</key><dict>",
      `<key>OPENCLAW_STATE_DIR</key><string>${stateDir}</string>`,
      `<key>OPENCLAW_CONFIG_PATH</key><string>${configPath}</string>`,
      "</dict>",
      "</dict></plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  writeExecutable(
    path.join(binDir, "launchctl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      '[[ "${1:-}" == "print" ]] || exit 2',
      'case "$TEST_LAUNCH_STATE" in',
      "  loaded) printf '%s\\n' '    pid = 4242' ; exit 0 ;;",
      "  absent) printf '%s\\n' 'Could not find service in domain' >&2; exit 113 ;;",
      "  error) printf '%s\\n' 'launchctl transport failed' >&2; exit 5 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(path.join(binDir, "defaults"), "#!/bin/sh\nprintf '%s\\n' primary\n");
  writeExecutable(path.join(binDir, "sqlite3"), "#!/bin/sh\nprintf '%s\\n' fixture-node\n");
  writeExecutable(
    path.join(binDir, "openclaw"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "$*" in',
      "  *'config get gateway.mode'*) printf '%s\\n' '\"remote\"' ;;",
      "  *'config get gateway.remote.url'*) printf '%s\\n' '\"wss://gateway.invalid\"' ;;",
      "  *'config get gateway.remote.token'*) printf '%s\\n' '\"redacted\"' ;;",
      "  *'config get gateway.remote.password'*) exit 1 ;;",
      '  *\'nodes status\'*) printf \'%s\\n\' \'{"nodes":[{"nodeId":"fixture-node","paired":true,"connected":false}]}\' ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );

  return {
    appPath,
    configPath,
    label,
    plistPath,
    stateDir,
    env: {
      ...process.env,
      HOME: tempRoot,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TEST_LAUNCH_STATE: launchState,
    },
  };
}

function createCanonicalNodeMigrationHarness(nodeId = "fixture-node") {
  const harness = createMigrationPlanHarness("loaded");
  const binDir = path.join(harness.env.HOME, "bin");
  const serviceEnvDir = path.join(harness.stateDir, "service-env");
  const label = "ai.openclaw.node";
  const plistPath = path.join(harness.env.HOME, "Library", "LaunchAgents", `${label}.plist`);
  const envPath = path.join(serviceEnvDir, `${label}.env`);
  const wrapperPath = path.join(serviceEnvDir, `${label}-env-wrapper.sh`);
  const nodePath = path.join(binDir, "node-runtime");
  const entrypointPath = path.join(harness.env.HOME, "openclaw", "dist", "index.js");
  mkdirSync(serviceEnvDir, { recursive: true });
  mkdirSync(path.dirname(entrypointPath), { recursive: true });
  writeFileSync(entrypointPath, "fixture", "utf8");
  writeFileSync(
    envPath,
    [
      "# Generated by OpenClaw. Do not edit while the gateway service is installed.",
      `export OPENCLAW_STATE_DIR='${harness.stateDir}'`,
      `export OPENCLAW_CONFIG_PATH='${harness.configPath}'`,
      "export OPENCLAW_GATEWAY_TOKEN=ignored-secret-shape",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(envPath, 0o600);
  writeExecutable(
    wrapperPath,
    [
      "#!/bin/sh",
      "set -eu",
      'env_file="$1"',
      "shift",
      'if [ -f "$env_file" ]; then',
      '  . "$env_file"',
      "fi",
      'exec "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(wrapperPath, 0o700);
  writeExecutable(
    nodePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "shift",
      'case "$*" in',
      "  *'config get gateway.mode'*) printf '%s\\n' '\"remote\"' ;;",
      "  *'config get gateway.remote.url'*) printf '%s\\n' '\"wss://gateway.invalid\"' ;;",
      "  *'config get gateway.remote.token'*) printf '%s\\n' '\"redacted\"' ;;",
      "  *'config get gateway.remote.password'*) exit 1 ;;",
      '  *\'nodes status\'*) printf \'%s\\n\' \'{"nodes":[{"nodeId":"fixture-node","paired":true,"connected":true,"connectedAtMs":10}]}\' ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeFileSync(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      `<key>Label</key><string>${label}</string>`,
      "<key>ProgramArguments</key><array>",
      "<string>/bin/sh</string>",
      `<string>${wrapperPath}</string>`,
      `<string>${envPath}</string>`,
      `<string>${nodePath}</string>`,
      `<string>${entrypointPath}</string>`,
      "<string>node</string><string>run</string><string>--host</string><string>gateway.invalid</string>",
      "<string>--port</string><string>18789</string><string>--no-tls</string>",
      `<string>--node-id</string><string>${nodeId}</string>`,
      "</array></dict></plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  return { ...harness, envPath, label, plistPath };
}

function addRunningAppFixture(harness: ReturnType<typeof createMigrationPlanHarness>) {
  const binDir = path.join(harness.env.HOME, "bin");
  const appBinary = `${harness.appPath}/Contents/MacOS/OpenClaw`;
  writeExecutable(path.join(binDir, "pgrep"), "#!/bin/sh\nprintf '%s\\n' 4242\n");
  writeExecutable(
    path.join(binDir, "lsof"),
    `#!/bin/sh\nprintf '%s\\n' p4242 n${JSON.stringify(appBinary)}\n`,
  );
  writeExecutable(
    path.join(binDir, "ps"),
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(`${appBinary} --attach-only --background-only`)}\n`,
  );
}

function createArtifactVerificationHarness() {
  const tempRoot = tempDirs.make("openclaw-elevation-artifact-");
  const binDir = path.join(tempRoot, "bin");
  const archivePath = path.join(tempRoot, "OpenClaw-fixture-stable.zip");
  const installerPath = path.join(tempRoot, "OpenClaw-fixture-stable-installer.sh");
  const receiptPath = path.join(tempRoot, "OpenClaw-fixture-stable.json");
  const dittoMarker = path.join(tempRoot, "ditto-called");
  const sourceCommit = "a".repeat(40);
  const peekabooCommit = "b".repeat(40);
  const entitlements = "<plist><dict/></plist>\n";
  mkdirSync(binDir, { recursive: true });
  writeFileSync(archivePath, "not-a-real-zip-but-deterministic", "utf8");
  writeExecutable(installerPath, readFileSync(scriptPath, "utf8"));
  writeExecutable(
    path.join(binDir, "ditto"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': >"$TEST_DITTO_MARKER"',
      'if [[ "$#" == "2" ]]; then',
      '  /usr/bin/ditto "$1" "$2"',
      "  exit 0",
      "fi",
      'destination="${4}"',
      'app="$destination/OpenClaw.app"',
      'mkdir -p "$app/Contents/MacOS"',
      'printf \'%s\\n\' \'<?xml version="1.0" encoding="UTF-8"?>\' \'<plist version="1.0"><dict>\' >"$app/Contents/Info.plist"',
      "printf '%s\\n' '<key>CFBundleIdentifier</key><string>ai.openclaw.mac</string>' >>\"$app/Contents/Info.plist\"",
      `printf '%s\\n' '<key>OpenClawGitCommit</key><string>${sourceCommit}</string>' >>"$app/Contents/Info.plist"`,
      `printf '%s\\n' '<key>PeekabooSourceCommit</key><string>${peekabooCommit}</string>' >>"$app/Contents/Info.plist"`,
      "printf '%s\\n' '<key>CFBundleShortVersionString</key><string>4.2.0</string>' '<key>CFBundleVersion</key><string>420</string>' '</dict></plist>' >>\"$app/Contents/Info.plist\"",
      "cat >\"$app/Contents/MacOS/OpenClaw\" <<'APP_HELPER'",
      "#!/bin/sh",
      'if [ "${1:-}" = "--elevation-rename-exclusive" ]; then',
      '  if [ "${TEST_SIGNAL_BEFORE_ROLLBACK_APP_MOVE:-0}" = "1" ] && echo "$3" | grep -q \'[.]rollback-elevation-host-\'; then',
      '    kill -TERM "$PPID"',
      "    exit 7",
      "  fi",
      '  /bin/mv -n "$2" "$3"',
      '  if [ "${TEST_SIGNAL_DURING_RECOVERY_APP_MOVE:-0}" = "1" ] && echo "$3" | grep -q \'[.]failed-elevation-host-.*[/]OpenClaw[.]app$\'; then',
      '    kill -TERM "$PPID"',
      "  fi",
      '  [ ! -e "$2" ]',
      "  exit $?",
      "fi",
      "exit 0",
      "APP_HELPER",
      'printf helper >"$app/Contents/MacOS/openclaw-mlx-tts"',
      'chmod 755 "$app/Contents/MacOS/OpenClaw" "$app/Contents/MacOS/openclaw-mlx-tts"',
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "codesign"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'target="${!#}"',
      'if [[ "$*" == *"--verify"* && -e "$target/Contents/invalid-signature" ]]; then',
      "  exit 1",
      "fi",
      'if [[ "$*" == *"--entitlements"* ]]; then',
      "  printf '%s\\n' '<plist><dict/></plist>'",
      "  exit 0",
      "fi",
      'if [[ "$*" == *"-dv"* ]]; then',
      "  cdhash=FIXTURECDHASH",
      '  if [[ -e "$target/Contents/old-fixture" ]]; then',
      "    cdhash=OLDFIXTURECDHASH",
      "  fi",
      "  printf '%s\\n' 'Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' >&2",
      "  printf '%s\\n' 'TeamIdentifier=FWJYW4S8P8' >&2",
      "  printf 'CDHash=%s\\n' \"$cdhash\" >&2",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "file"),
    "#!/bin/sh\nprintf '%s\\n' \"$1: Mach-O universal binary\"\n",
  );
  writeExecutable(path.join(binDir, "lipo"), "#!/bin/sh\nprintf '%s\\n' 'x86_64 arm64'\n");
  writeExecutable(path.join(binDir, "spctl"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(binDir, "xcrun"), "#!/bin/sh\nexit 0\n");
  const receipt = {
    schemaVersion: 1,
    kind: "openclaw-elevation-artifact",
    archive: path.basename(archivePath),
    archiveSha256: sha256(readFileSync(archivePath)),
    archiveChecksum: `${path.basename(archivePath)}.sha256`,
    installer: path.basename(installerPath),
    installerSha256: sha256(readFileSync(installerPath)),
    installerChecksum: `${path.basename(installerPath)}.sha256`,
    sourceCommit,
    peekabooCommit,
    version: "4.2.0",
    build: "420",
    authority: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
    teamIdentifier: "FWJYW4S8P8",
    cdhashes: { arm64: "FIXTURECDHASH", x86_64: "FIXTURECDHASH" },
    architectures: { main: "x86_64 arm64", helper: "x86_64 arm64" },
    entitlementsSha256: { main: sha256(entitlements), helper: sha256(entitlements) },
    notarizationId: "12345678-1234-1234-1234-123456789abc",
  };
  writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
  return {
    archivePath,
    dittoMarker,
    installerPath,
    peekabooCommit,
    receipt,
    receiptPath,
    sourceCommit,
    env: {
      ...process.env,
      HOME: tempRoot,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TEST_DITTO_MARKER: dittoMarker,
      TMPDIR: tempRoot,
    },
  };
}
function createInstallRollbackHarness(
  options: {
    failCurrentReceiptRestoreCopy?: boolean;
    failAfterReceiptCommitMove?: boolean;
    failLsofInspection?: boolean;
    hupDuringCustody?: boolean;
    launchdBootstrapFails?: boolean;
    migrationRestoreBootstrapFails?: boolean;
    recreateSourceDuringBootout?: boolean;
    recreateSourceOnFailure?: boolean;
    restartAppDuringBootout?: boolean;
    signalDuringCustody?: boolean;
    signalDuringRecoveryAppMove?: boolean;
    signalDuringReceiptCommit?: boolean;
    signalBeforeRollbackAppMove?: boolean;
    sameSourceExistingApp?: boolean;
    transientAppRestartReloadsJob?: boolean;
  } = {},
) {
  const artifact = createArtifactVerificationHarness();
  const tempRoot = artifact.env.HOME;
  const binDir = path.join(tempRoot, "bin");
  const stateDir = path.join(tempRoot, "node-state");
  const configPath = path.join(stateDir, "openclaw.json");
  const appPath = path.join(tempRoot, "InstalledOpenClaw.app");
  const oldSourceCommit = options.sameSourceExistingApp ? artifact.sourceCommit : "c".repeat(40);
  const oldPeekabooCommit = "d".repeat(40);
  const label = "ai.openclaw.mac.node-fixture";
  const launchAgentsDir = path.join(tempRoot, "Library", "LaunchAgents");
  const sourcePlist = path.join(launchAgentsDir, `${label}.plist`);
  const launchStateFile = path.join(tempRoot, "launch-state");
  const nodeGenerationFile = path.join(tempRoot, "node-generation");
  mkdirSync(path.join(stateDir, "state"), { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  writeFileSync(configPath, "{}\n", "utf8");
  writeFileSync(path.join(stateDir, "state", "openclaw.sqlite"), "fixture", "utf8");
  writeAppInfoPlist(appPath, oldSourceCommit, oldPeekabooCommit);
  writeExecutable(path.join(appPath, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(appPath, "Contents", "old-fixture"), "old\n", "utf8");
  const sourceContents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${label}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${appPath}/Contents/MacOS/OpenClaw</string>`,
    "<string>--attach-only</string><string>--background-only</string>",
    "</array>",
    "<key>EnvironmentVariables</key><dict>",
    `<key>OPENCLAW_STATE_DIR</key><string>${stateDir}</string>`,
    `<key>OPENCLAW_CONFIG_PATH</key><string>${configPath}</string>`,
    "</dict></dict></plist>",
    "",
  ].join("\n");
  writeFileSync(sourcePlist, sourceContents, "utf8");
  writeFileSync(launchStateFile, "source-loaded\n", "utf8");
  writeFileSync(nodeGenerationFile, "0\n", "utf8");
  writeExecutable(path.join(binDir, "defaults"), "#!/bin/sh\nprintf '%s\\n' primary\n");
  writeExecutable(path.join(binDir, "sqlite3"), "#!/bin/sh\nprintf '%s\\n' fixture-node\n");
  writeExecutable(
    path.join(binDir, "pgrep"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'state="$(tr -d \'\\n\' <"$TEST_LAUNCH_STATE_FILE")"',
      'if [[ "$TEST_FAIL_LSOF_INSPECTION" == "1" && "$state" == "source-absent" ]]; then',
      "  printf '%s\\n' \"$TEST_LIVE_PID\"",
      "  exit 0",
      "fi",
      'if [[ "$TEST_TRANSIENT_APP_RESTART_RELOADS_JOB" == "1" && "$state" == "source-absent" ]]; then',
      "  printf '%s\\n' source-loaded >\"$TEST_LAUNCH_STATE_FILE\"",
      "  printf '%s\\n' 777777",
      "  exit 0",
      "fi",
      'if [[ "$TEST_RESTART_APP_DURING_BOOTOUT" == "1" && "$state" == "source-absent" ]]; then',
      "  printf '%s\\n' 777777",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "lsof"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      '[[ "$TEST_FAIL_LSOF_INSPECTION" != "1" ]] || exit 7',
      `printf '%s\\n' p777777 n${JSON.stringify(path.join(appPath, "Contents", "MacOS", "OpenClaw"))}`,
      "",
    ].join("\n"),
  );
  writeExecutable(path.join(binDir, "sleep"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    path.join(binDir, "mv"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'destination="${!#}"',
      'if [[ "$TEST_SIGNAL_DURING_CUSTODY" == "1" && "$destination" == *.custody.* ]]; then',
      '  /bin/mv "$@"',
      '  kill -"$TEST_CUSTODY_SIGNAL" "$PPID"',
      "  exit 0",
      "fi",
      'if [[ "$TEST_SIGNAL_DURING_RECEIPT_COMMIT" == "1" && "$destination" == */elevation-host-install.json ]]; then',
      '  /bin/mv "$@"',
      '  kill -TERM "$PPID"',
      "  exit 0",
      "fi",
      'if [[ "$TEST_FAIL_AFTER_RECEIPT_COMMIT_MOVE" == "1" && "$destination" == */elevation-host-install.json ]]; then',
      '  /bin/mv "$@"',
      "  exit 7",
      "fi",
      'if [[ "$TEST_SIGNAL_DURING_RECOVERY_APP_MOVE" == "1" && "$destination" == *.failed-elevation-host-*/OpenClaw.app ]]; then',
      '  /bin/mv "$@"',
      '  kill -TERM "$PPID"',
      "  exit 0",
      "fi",
      'if [[ "$TEST_SIGNAL_BEFORE_ROLLBACK_APP_MOVE" == "1" && "$destination" == *.rollback-elevation-host-* ]]; then',
      '  kill -TERM "$PPID"',
      "  exit 7",
      "fi",
      'exec /bin/mv "$@"',
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "cp"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'destination="${!#}"',
      'if [[ "$TEST_FAIL_CURRENT_RECEIPT_RESTORE_COPY" == "1" && "$destination" == *elevation-host-install.json.restore.* ]]; then',
      "  printf '%s\\n' partial >\"$destination\"",
      "  exit 7",
      "fi",
      'exec /bin/cp "$@"',
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "openclaw"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "$*" in',
      "  *'config get gateway.mode'*) printf '%s\\n' '\"remote\"' ;;",
      "  *'config get gateway.remote.url'*) printf '%s\\n' '\"wss://gateway.invalid\"' ;;",
      "  *'config get gateway.remote.token'*) printf '%s\\n' '\"redacted\"' ;;",
      "  *'config get gateway.remote.password'*) exit 1 ;;",
      "  *'nodes status'*)",
      '    state="$(tr -d \'\\n\' <"$TEST_LAUNCH_STATE_FILE")"',
      '    if [[ "$state" == "elevation-loaded" ]]; then',
      '      generation="$(tr -d \'\\n\' <"$TEST_NODE_GENERATION_FILE")"',
      '      connected_at="$((10 + generation * 10))"',
      '      printf \'{"nodes":[{"nodeId":"fixture-node","paired":true,"connected":true,"connectedAtMs":%s,"clientId":"openclaw-macos","clientMode":"node","uiVersion":"4.2.0","caps":["computer"],"commands":["screen.snapshot","computer.act"],"computerUse":{"version":2}}]}\\n\' "$connected_at"',
      "    else",
      '      printf \'%s\\n\' \'{"nodes":[{"nodeId":"fixture-node","paired":true,"connected":true,"connectedAtMs":10}]}\'',
      "    fi ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "launchctl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'command_name="${1:-}"',
      'target="${2:-}"',
      'state="$(tr -d \'\\n\' <"$TEST_LAUNCH_STATE_FILE")"',
      'if [[ "$command_name" == "print" ]]; then',
      '  if [[ "$target" == */ai.openclaw.mac.node-fixture && "$state" == "source-loaded" ]]; then',
      "    printf '%s\\n' '    pid = 999999'",
      "    exit 0",
      "  fi",
      '  if [[ "$target" == */ai.openclaw.mac.elevation-host && "$state" == "elevation-loaded" ]]; then',
      "    printf '%s\\n' '    pid = 555555'",
      "    exit 0",
      "  fi",
      "  printf '%s\\n' 'Could not find service in domain' >&2",
      "  exit 113",
      "fi",
      'if [[ "$command_name" == "bootout" && "$target" == */ai.openclaw.mac.node-fixture ]]; then',
      "  printf '%s\\n' source-absent >\"$TEST_LAUNCH_STATE_FILE\"",
      '  if [[ "$TEST_RECREATE_SOURCE_DURING_BOOTOUT" == "1" ]]; then',
      "    printf '%s\\n' replacement-owner >\"$TEST_SOURCE_PLIST\"",
      "  fi",
      "  exit 0",
      "fi",
      'if [[ "$command_name" == "bootout" && "$target" == */ai.openclaw.mac.elevation-host ]]; then',
      "  printf '%s\\n' elevation-absent >\"$TEST_LAUNCH_STATE_FILE\"",
      "  exit 0",
      "fi",
      'if [[ "$command_name" == "bootstrap" ]]; then',
      '  plist="${3:-}"',
      '  if [[ "$plist" == *ai.openclaw.mac.elevation-host.plist ]]; then',
      '    if [[ "$TEST_LAUNCHD_BOOTSTRAP_FAILS" == "1" ]]; then',
      '      if [[ "$TEST_RECREATE_SOURCE_ON_FAILURE" == "1" ]]; then',
      "        printf '%s\\n' replacement-owner >\"$TEST_SOURCE_PLIST\"",
      "      fi",
      "      exit 7",
      "    fi",
      '    generation="$(tr -d \'\\n\' <"$TEST_NODE_GENERATION_FILE")"',
      '    printf \'%s\\n\' "$((generation + 1))" >"$TEST_NODE_GENERATION_FILE"',
      "    printf '%s\\n' elevation-loaded >\"$TEST_LAUNCH_STATE_FILE\"",
      "    exit 0",
      "  fi",
      '  if [[ "$plist" == *ai.openclaw.mac.node-fixture.plist ]]; then',
      '    if [[ "$TEST_MIGRATION_RESTORE_BOOTSTRAP_FAILS" == "1" ]]; then',
      "      exit 9",
      "    fi",
      "    printf '%s\\n' source-loaded >\"$TEST_LAUNCH_STATE_FILE\"",
      "    exit 0",
      "  fi",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "peekaboo"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "bridge" ]]; then',
      '  printf \'%s\\n\' \'{"success":true,"data":{"selected":{"handshake":{"hostIdentity":{"processIdentifier":555555}}}}}\'',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "permissions" ]]; then',
      '  printf \'%s\\n\' \'{"success":true,"data":{"sources":[{"isSelected":true,"permissions":[{"name":"Screen Recording","isGranted":true}]}]}}\'',
      "  exit 0",
      "fi",
      "exit 2",
      "",
    ].join("\n"),
  );
  return {
    ...artifact,
    appPath,
    configPath,
    label,
    launchStateFile,
    sourceContents,
    sourcePlist,
    stateDir,
    env: {
      ...artifact.env,
      TEST_FAIL_CURRENT_RECEIPT_RESTORE_COPY: options.failCurrentReceiptRestoreCopy ? "1" : "0",
      TEST_FAIL_AFTER_RECEIPT_COMMIT_MOVE: options.failAfterReceiptCommitMove ? "1" : "0",
      TEST_FAIL_LSOF_INSPECTION: options.failLsofInspection ? "1" : "0",
      TEST_CUSTODY_SIGNAL: options.hupDuringCustody ? "HUP" : "TERM",
      TEST_LAUNCHD_BOOTSTRAP_FAILS: options.launchdBootstrapFails === false ? "0" : "1",
      TEST_LIVE_PID: String(process.pid),
      TEST_LAUNCH_STATE_FILE: launchStateFile,
      TEST_NODE_GENERATION_FILE: nodeGenerationFile,
      TEST_MIGRATION_RESTORE_BOOTSTRAP_FAILS: options.migrationRestoreBootstrapFails ? "1" : "0",
      TEST_RECREATE_SOURCE_DURING_BOOTOUT: options.recreateSourceDuringBootout ? "1" : "0",
      TEST_RECREATE_SOURCE_ON_FAILURE: options.recreateSourceOnFailure ? "1" : "0",
      TEST_RESTART_APP_DURING_BOOTOUT: options.restartAppDuringBootout ? "1" : "0",
      TEST_SIGNAL_DURING_CUSTODY:
        options.signalDuringCustody || options.hupDuringCustody ? "1" : "0",
      TEST_SIGNAL_DURING_RECOVERY_APP_MOVE: options.signalDuringRecoveryAppMove ? "1" : "0",
      TEST_SIGNAL_DURING_RECEIPT_COMMIT: options.signalDuringReceiptCommit ? "1" : "0",
      TEST_SIGNAL_BEFORE_ROLLBACK_APP_MOVE: options.signalBeforeRollbackAppMove ? "1" : "0",
      TEST_TRANSIENT_APP_RESTART_RELOADS_JOB: options.transientAppRestartReloadsJob ? "1" : "0",
      TEST_SOURCE_PLIST: sourcePlist,
    },
  };
}

describe("mac elevation host command contract", () => {
  it("documents package and transactional lifecycle commands without probing macOS", () => {
    const result = spawnSync("bash", [scriptPath, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("package --peekaboo-source-commit <sha>");
    expect(result.stdout).toContain("verify --archive <zip> --receipt <json>");
    expect(result.stdout).toContain("install --archive <zip> --receipt <json>");
    expect(result.stdout).toContain(
      "migration-plan [--migrate-launch-agent <plist>|--adopt-running-app]",
    );
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("recover");
    expect(result.stdout).toContain("uninstall");
    expect(result.stdout).toContain("never rewrites ordinary OpenClaw");
  });

  it("keeps the elevation service separate and fail-closed", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('ELEVATION_LABEL="ai.openclaw.mac.elevation-host"');
    expect(script).toContain('NORMAL_LABEL="ai.openclaw.mac"');
    expect(script).toContain("ordinary Launch at login is installed");
    expect(script).toContain("conflicting OpenClaw launch agent is installed");
    expect(script).toContain("unsupervised or conflicting OpenClaw process is running");
    expect(script).toContain("plutil -insert KeepAlive -bool true");
    expect(script).toContain("plutil -insert RunAtLoad -bool true");
    expect(script).toContain('[$executable,"--elevation-host"]');
    expect(script).toContain("automatic elevation-host rollback was incomplete");
    expect(script).not.toContain("osascript");
  });

  it("runs the portable lifecycle installer without a source checkout", () => {
    const harness = createArtifactVerificationHarness();
    const binDir = path.join(harness.env.HOME, "bin");
    const launchctl = path.join(binDir, "launchctl");
    writeFileSync(launchctl, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(launchctl, 0o755);

    const result = runInstaller(
      harness.installerPath,
      ["uninstall"],
      harness.env,
      harness.env.HOME,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Elevation launch agent removed");
  });

  it.skipIf(process.platform !== "darwin")(
    "plans an explicit app-backed node migration without mutating its plist",
    () => {
      const harness = createMigrationPlanHarness();
      const before = readFileSync(harness.plistPath, "utf8");
      const result = runInstaller(
        scriptPath,
        ["migration-plan", "--app", harness.appPath, "--migrate-launch-agent", harness.plistPath],
        harness.env,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        kind: "app-launch-agent",
        label: harness.label,
        sourcePlist: harness.plistPath,
        stateDir: harness.stateDir,
        configPath: harness.configPath,
        expectedNodeId: "fixture-node",
        loaded: false,
        action: "replace-with-elevation-host",
      });
      expect(readFileSync(harness.plistPath, "utf8")).toBe(before);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rejects an explicit config path that differs from the source owner's default",
    () => {
      const harness = createMigrationPlanHarness();
      const plist = readFileSync(harness.plistPath, "utf8").replace(
        `<key>OPENCLAW_CONFIG_PATH</key><string>${harness.configPath}</string>\n`,
        "",
      );
      writeFileSync(harness.plistPath, plist, "utf8");
      const result = runInstaller(
        scriptPath,
        [
          "migration-plan",
          "--app",
          harness.appPath,
          "--config-path",
          path.join(harness.stateDir, "other.json"),
          "--migrate-launch-agent",
          harness.plistPath,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "--config-path does not match the migration LaunchAgent OPENCLAW_CONFIG_PATH",
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "verifies the portable installer, archive, notarized app identity, and receipt as one set",
    () => {
      const harness = createArtifactVerificationHarness();
      const unauthenticated = runInstaller(
        harness.installerPath,
        ["verify", "--archive", harness.archivePath, "--receipt", harness.receiptPath],
        harness.env,
      );
      expect(unauthenticated.status).toBe(1);
      expect(unauthenticated.stderr).toContain(
        "verify requires --receipt-sha256 <sha256> from the authenticated release handoff",
      );

      const verified = runInstaller(
        harness.installerPath,
        [
          "verify",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
        ],
        harness.env,
      );
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout).toContain("Elevation artifact verified");
      expect(existsSync(harness.dittoMarker)).toBe(true);

      const substitutedArchive = createArtifactVerificationHarness();
      writeFileSync(substitutedArchive.archivePath, "substituted archive", "utf8");
      const rejectedBeforeExtraction = runInstaller(
        substitutedArchive.installerPath,
        [
          "verify",
          "--archive",
          substitutedArchive.archivePath,
          "--receipt",
          substitutedArchive.receiptPath,
          ...receiptDigestArgs(substitutedArchive.receiptPath),
        ],
        substitutedArchive.env,
      );
      expect(rejectedBeforeExtraction.status).toBe(1);
      expect(rejectedBeforeExtraction.stderr).toContain("artifact receipt archive digest mismatch");
      expect(existsSync(substitutedArchive.dittoMarker)).toBe(false);

      const substitutedDir = path.join(harness.env.HOME, "substituted");
      mkdirSync(substitutedDir);
      const substitutedInstaller = path.join(substitutedDir, path.basename(harness.installerPath));
      writeExecutable(
        substitutedInstaller,
        `${readFileSync(harness.installerPath, "utf8")}\n# substituted\n`,
      );
      const substituted = runInstaller(
        substitutedInstaller,
        [
          "verify",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
        ],
        harness.env,
      );
      expect(substituted.status).toBe(1);
      expect(substituted.stderr).toContain("artifact receipt installer digest mismatch");

      writeFileSync(
        harness.receiptPath,
        JSON.stringify({ ...harness.receipt, archiveSha256: "0".repeat(64) }),
        "utf8",
      );
      const rejected = runInstaller(
        harness.installerPath,
        [
          "verify",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          "--receipt-sha256",
          sha256(JSON.stringify(harness.receipt)),
        ],
        harness.env,
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(
        "artifact receipt does not match the authenticated release handoff digest",
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "plans canonical node conversion without reading or copying its token",
    () => {
      const harness = createCanonicalNodeMigrationHarness();
      const result = runInstaller(
        scriptPath,
        ["migration-plan", "--app", harness.appPath, "--migrate-launch-agent", harness.plistPath],
        harness.env,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "canonical-node",
        label: harness.label,
        stateDir: harness.stateDir,
        configPath: harness.configPath,
        expectedNodeId: "fixture-node",
        loaded: true,
      });
      expect(result.stdout).not.toContain("ignored-secret-shape");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rejects a canonical node override that differs from the selected paired app identity",
    () => {
      const harness = createCanonicalNodeMigrationHarness("different-node");
      const result = runInstaller(
        scriptPath,
        ["migration-plan", "--app", harness.appPath, "--migrate-launch-agent", harness.plistPath],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "canonical node LaunchAgent --node-id does not match the selected paired macOS identity",
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rejects a relative canonical node state directory",
    () => {
      const harness = createCanonicalNodeMigrationHarness();
      writeFileSync(
        harness.envPath,
        [
          "export OPENCLAW_STATE_DIR='relative-state'",
          `export OPENCLAW_CONFIG_PATH='${harness.configPath}'`,
          "",
        ].join("\n"),
        "utf8",
      );
      const result = runInstaller(
        scriptPath,
        ["migration-plan", "--app", harness.appPath, "--migrate-launch-agent", harness.plistPath],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("canonical node OPENCLAW_STATE_DIR must be absolute");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "plans explicit adoption of one unsupervised background app",
    () => {
      const harness = createMigrationPlanHarness();
      addRunningAppFixture(harness);
      const result = runInstaller(
        scriptPath,
        [
          "migration-plan",
          "--app",
          harness.appPath,
          "--state-dir",
          harness.stateDir,
          "--config-path",
          harness.configPath,
          "--adopt-running-app",
        ],
        harness.env,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "running-app",
        label: null,
        sourcePlist: null,
        stateDir: harness.stateDir,
        configPath: harness.configPath,
        expectedNodeId: "fixture-node",
        loaded: false,
      });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses to adopt the launchd-owned elevation process",
    () => {
      const harness = createMigrationPlanHarness("loaded");
      addRunningAppFixture(harness);
      const result = runInstaller(
        scriptPath,
        [
          "migration-plan",
          "--app",
          harness.appPath,
          "--state-dir",
          harness.stateDir,
          "--config-path",
          harness.configPath,
          "--adopt-running-app",
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("adoption refuses the launchd-owned elevation process");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "fails closed when launchd ownership cannot be inspected for migration",
    () => {
      const harness = createMigrationPlanHarness("error");
      const result = runInstaller(
        scriptPath,
        ["migration-plan", "--app", harness.appPath, "--migrate-launch-agent", harness.plistPath],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("launchd ownership state could not be inspected");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "restores the exact app, source LaunchAgent, and loaded state when cutover launchd bootstrap fails",
    () => {
      const harness = createInstallRollbackHarness();
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const priorFailedPath = `${harness.appPath}.failed-elevation-host-${"a".repeat(40)}`;
      mkdirSync(priorFailedPath);
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not bootstrap elevation host");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(priorFailedPath)).toBe(true);
      expect(
        existsSync(
          path.join(
            harness.env.HOME,
            "Library",
            "LaunchAgents",
            "ai.openclaw.mac.elevation-host.plist",
          ),
        ),
      ).toBe(false);
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses to record an invalid existing app as rollback state",
    () => {
      const harness = createInstallRollbackHarness();
      writeFileSync(
        path.join(harness.appPath, "Contents", "invalid-signature"),
        "invalid\n",
        "utf8",
      );
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "installed OpenClaw app does not pass strict signature and identity validation",
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "never removes a replacement LaunchAgent created while the source owner exits",
    () => {
      const harness = createInstallRollbackHarness({
        launchdBootstrapFails: false,
        recreateSourceDuringBootout: true,
      });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "migration LaunchAgent path was recreated before cutover commit",
      );
      expect(result.stderr).toContain("automatic elevation-host rollback was incomplete");
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe("replacement-owner\n");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-absent");
      const backupName = readdirSync(harness.stateDir).find((name) =>
        name.startsWith("elevation-host.previous-launch-agent."),
      );
      expect(backupName).toBeDefined();
      expect(readFileSync(path.join(harness.stateDir, backupName!), "utf8")).toBe(
        harness.sourceContents,
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "restores exact source ownership when termination arrives during custody transfer",
    () => {
      const harness = createInstallRollbackHarness({ signalDuringCustody: true });
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.signal).toBe("SIGTERM");
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(readdirSync(path.dirname(harness.sourcePlist))).not.toContainEqual(
        expect.stringContaining(".custody."),
      );
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "restores exact source ownership when hangup arrives during custody transfer",
    () => {
      const harness = createInstallRollbackHarness({ hupDuringCustody: true });
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.signal).toBe("SIGHUP");
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(readdirSync(path.dirname(harness.sourcePlist))).not.toContainEqual(
        expect.stringContaining(".custody."),
      );
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps a same-source prior app canonical when its rollback move never starts",
    () => {
      const harness = createInstallRollbackHarness({
        sameSourceExistingApp: true,
        signalBeforeRollbackAppMove: true,
      });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.signal).toBe("SIGTERM");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses cutover when an app-backed owner restarts before bootout completes",
    () => {
      const harness = createInstallRollbackHarness({ restartAppDuringBootout: true });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("an OpenClaw app process survived owner shutdown");
      expect(result.stderr).toContain("automatic elevation-host rollback was incomplete");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(existsSync(harness.sourcePlist)).toBe(false);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-absent");
      const backupName = readdirSync(harness.stateDir).find((name) =>
        name.startsWith("elevation-host.previous-launch-agent."),
      );
      expect(backupName).toBeDefined();
      expect(readFileSync(path.join(harness.stateDir, backupName!), "utf8")).toBe(
        harness.sourceContents,
      );
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rechecks launchd after a transient replacement app process exits",
    () => {
      const harness = createInstallRollbackHarness({ transientAppRestartReloadsJob: true });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("migration LaunchAgent reloaded during owner shutdown");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "never treats a live but uninspectable OpenClaw PID as quiescent",
    () => {
      const harness = createInstallRollbackHarness({ failLsofInspection: true });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("an OpenClaw app process survived owner shutdown");
      expect(result.stderr).toContain("automatic elevation-host rollback was incomplete");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(existsSync(harness.sourcePlist)).toBe(false);
      const backupName = readdirSync(harness.stateDir).find((name) =>
        name.startsWith("elevation-host.previous-launch-agent."),
      );
      expect(backupName).toBeDefined();
      expect(readFileSync(path.join(harness.stateDir, backupName!), "utf8")).toBe(
        harness.sourceContents,
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "preserves rollback evidence when automatic recovery cannot restore the source owner",
    () => {
      const harness = createInstallRollbackHarness({ recreateSourceOnFailure: true });
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("automatic elevation-host rollback was incomplete");
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe("replacement-owner\n");
      const backupName = readdirSync(harness.stateDir).find((name) =>
        name.startsWith("elevation-host.previous-launch-agent."),
      );
      expect(backupName).toBeDefined();
      expect(readFileSync(path.join(harness.stateDir, backupName!), "utf8")).toBe(
        harness.sourceContents,
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "commits only after the exact macOS computer-use node reconnects through the new app",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Elevation host installed: pid=555555");
      expect(existsSync(harness.sourcePlist)).toBe(false);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
      const installReceipt = JSON.parse(
        readFileSync(path.join(harness.stateDir, "elevation-host-install.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(installReceipt).toMatchObject({
        kind: "openclaw-elevation-install",
        nodeId: "fixture-node",
        nodeProfile: "primary",
      });
      expect(installReceipt.migration).toMatchObject({
        label: harness.label,
        wasLoaded: true,
      });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "commits the receipt and cutover marker before replaying termination",
    () => {
      const harness = createInstallRollbackHarness({
        launchdBootstrapFails: false,
        signalDuringReceiptCommit: true,
      });
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.signal).toBe("SIGTERM");
      expect(existsSync(harness.sourcePlist)).toBe(false);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
      const receipt = JSON.parse(
        readFileSync(path.join(harness.stateDir, "elevation-host-install.json"), "utf8"),
      ) as { sourceCommit: string };
      expect(receipt.sourceCommit).toBe(harness.sourceCommit);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "removes an ambiguously published first-install receipt during rollback",
    () => {
      const harness = createInstallRollbackHarness({
        failAfterReceiptCommitMove: true,
        launchdBootstrapFails: false,
      });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const result = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );

      expect(result.status).toBe(7);
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rejects managed upgrades that change the recorded config or node profile",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);

      const mismatchedConfig = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--state-dir",
          harness.stateDir,
          "--config-path",
          path.join(harness.stateDir, "other.json"),
        ],
        harness.env,
      );
      expect(mismatchedConfig.status).toBe(1);
      expect(mismatchedConfig.stderr).toContain(
        "--config-path does not match the existing elevation install receipt",
      );

      writeExecutable(
        path.join(harness.env.HOME, "bin", "defaults"),
        "#!/bin/sh\nprintf '%s\\n' node\n",
      );
      const mismatchedProfile = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--state-dir",
          harness.stateDir,
        ],
        harness.env,
      );
      expect(mismatchedProfile.status).toBe(1);
      expect(mismatchedProfile.stderr).toContain(
        "managed upgrade identity does not match the existing elevation install receipt",
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "explicitly recovers the prior app and source job from the verified install receipt",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
      expect(
        readdirSync(harness.stateDir).some((name) =>
          name.startsWith("elevation-host.recovered-receipt."),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "defers termination until explicit recovery commits one complete generation",
    () => {
      const harness = createInstallRollbackHarness({
        launchdBootstrapFails: false,
        signalDuringRecoveryAppMove: true,
      });
      const oldBinary = readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"));
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.signal).toBe("SIGTERM");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        oldBinary,
      );
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(path.join(harness.stateDir, "elevation-host-install.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "recovers a migrated source owner when no prior app existed",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const receipt = JSON.parse(readFileSync(installReceiptPath, "utf8")) as {
        backupCDHash: string;
        backupPath: string;
      };
      rmSync(receipt.backupPath, { recursive: true });
      receipt.backupPath = "";
      receipt.backupCDHash = "";
      writeFileSync(installReceiptPath, JSON.stringify(receipt), "utf8");

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.status, recovered.stderr).toBe(0);
      expect(existsSync(harness.appPath)).toBe(false);
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe(harness.sourceContents);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("source-loaded");
      expect(existsSync(installReceiptPath)).toBe(false);
      expect(recovered.stdout).toContain("replaced app preserved at");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "restores the current generation when explicit recovery cannot restart the prior owner",
    () => {
      const harness = createInstallRollbackHarness({
        launchdBootstrapFails: false,
        migrationRestoreBootstrapFails: true,
      });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = readFileSync(installReceiptPath, "utf8");
      const currentBinary = readFileSync(
        path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"),
      );
      const rollbackPath = (JSON.parse(currentReceipt) as { backupPath: string }).backupPath;

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain(
        "could not restore the previous OpenClaw installation completely",
      );
      expect(readFileSync(installReceiptPath, "utf8")).toBe(currentReceipt);
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        currentBinary,
      );
      expect(existsSync(rollbackPath)).toBe(true);
      expect(existsSync(harness.sourcePlist)).toBe(false);
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "never replaces the live receipt with a failed reversal staging copy",
    () => {
      const harness = createInstallRollbackHarness({
        failCurrentReceiptRestoreCopy: true,
        launchdBootstrapFails: false,
        migrationRestoreBootstrapFails: true,
      });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = readFileSync(installReceiptPath, "utf8");

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain(
        "current OpenClaw installation could not be restored completely",
      );
      expect(readFileSync(installReceiptPath, "utf8")).toBe(currentReceipt);
      expect(readFileSync(installReceiptPath, "utf8")).not.toContain("partial");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses recovery before mutation when the recorded app backup is missing",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = readFileSync(installReceiptPath, "utf8");
      const currentBinary = readFileSync(
        path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"),
      );
      const rollbackPath = (JSON.parse(currentReceipt) as { backupPath: string }).backupPath;
      rmSync(rollbackPath, { recursive: true });

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain(
        "receipt app backup is missing, symlinked, or not a bundle directory",
      );
      expect(readFileSync(installReceiptPath, "utf8")).toBe(currentReceipt);
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        currentBinary,
      );
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses recovery before mutation when the app backup signature is invalid",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = readFileSync(installReceiptPath, "utf8");
      const currentBinary = readFileSync(
        path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"),
      );
      const rollbackPath = (JSON.parse(currentReceipt) as { backupPath: string }).backupPath;
      writeFileSync(path.join(rollbackPath, "Contents", "invalid-signature"), "invalid\n", "utf8");

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain(
        "receipt app backup does not pass strict signature and identity validation",
      );
      expect(readFileSync(installReceiptPath, "utf8")).toBe(currentReceipt);
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        currentBinary,
      );
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses a corrupt migration backup before stopping the current generation",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = readFileSync(installReceiptPath, "utf8");
      const receipt = JSON.parse(currentReceipt) as { migration: { backupPlist: string } };
      const currentBinary = readFileSync(
        path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"),
      );
      writeFileSync(receipt.migration.backupPlist, "corrupt\n", "utf8");

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain("migration plist backup failed digest validation");
      expect(readFileSync(installReceiptPath, "utf8")).toBe(currentReceipt);
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        currentBinary,
      );
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "preserves an origin-main legacy receipt across upgrade recovery and reinstall",
    () => {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain(
        'receipt_restore_tmp="$(mktemp "$STATE_DIR/elevation-host.restore-receipt.${ROLLBACK_FAILED_SOURCE}.XXXXXX")"',
      );
      expect(script).not.toContain('receipt_restore_tmp="${RECEIPT_PATH}.restore.$$"');

      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const firstInstall = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(firstInstall.status, firstInstall.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = JSON.parse(readFileSync(installReceiptPath, "utf8")) as Record<
        string,
        unknown
      >;
      const legacyReceipt = {
        sourceCommit: currentReceipt.sourceCommit,
        peekabooCommit: currentReceipt.peekabooCommit,
        archiveSha256: currentReceipt.archiveSha256,
        appPath: currentReceipt.appPath,
        backupPath: currentReceipt.backupPath,
        plistPath: currentReceipt.plistPath,
        previousPlist: currentReceipt.previousPlist,
      };
      writeFileSync(installReceiptPath, JSON.stringify(legacyReceipt), "utf8");
      const firstReceipt = readFileSync(installReceiptPath, "utf8");

      const managedInstallArgs = [
        "install",
        "--archive",
        harness.archivePath,
        "--receipt",
        harness.receiptPath,
        ...receiptDigestArgs(harness.receiptPath),
        "--app",
        harness.appPath,
        "--state-dir",
        harness.stateDir,
        "--config-path",
        harness.configPath,
      ];
      const upgrade = runInstaller(harness.installerPath, managedInstallArgs, harness.env);
      expect(upgrade.status, upgrade.stderr).toBe(0);
      const upgradeReceipt = JSON.parse(readFileSync(installReceiptPath, "utf8")) as {
        previousReceipt: string;
        previousReceiptSha256: string;
      };
      expect(upgradeReceipt.previousReceipt).toContain("elevation-host.previous-receipt.");
      expect(upgradeReceipt.previousReceiptSha256).toBe(sha256(firstReceipt));

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(installReceiptPath, "utf8")).toBe(firstReceipt);
      expect(recovered.stdout).toContain("replaced app preserved at");

      const legacyStatus = runInstaller(
        harness.installerPath,
        ["status", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );
      expect(legacyStatus.status, legacyStatus.stderr).toBe(0);
      expect(legacyStatus.stdout).toContain("Elevation host ready");

      const reinstalled = runInstaller(harness.installerPath, managedInstallArgs, harness.env);
      expect(reinstalled.status, reinstalled.stderr).toBe(0);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "inherits legacy managed-upgrade config from the installed elevation plist",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const currentReceipt = JSON.parse(readFileSync(installReceiptPath, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        installReceiptPath,
        JSON.stringify({
          sourceCommit: currentReceipt.sourceCommit,
          peekabooCommit: currentReceipt.peekabooCommit,
          archiveSha256: currentReceipt.archiveSha256,
          appPath: currentReceipt.appPath,
          backupPath: currentReceipt.backupPath,
          plistPath: currentReceipt.plistPath,
          previousPlist: currentReceipt.previousPlist,
        }),
        "utf8",
      );
      const customConfig = path.join(harness.stateDir, "custom-openclaw.json");
      writeFileSync(customConfig, "{}\n", "utf8");
      const elevationPlistPath = path.join(
        harness.env.HOME,
        "Library",
        "LaunchAgents",
        "ai.openclaw.mac.elevation-host.plist",
      );
      writeFileSync(
        elevationPlistPath,
        readFileSync(elevationPlistPath, "utf8").replace(harness.configPath, customConfig),
        "utf8",
      );

      const mismatched = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--state-dir",
          harness.stateDir,
          "--config-path",
          harness.configPath,
        ],
        harness.env,
      );

      expect(mismatched.status).toBe(1);
      expect(mismatched.stderr).toContain(
        "--config-path does not match the existing elevation install receipt",
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses recovery when another owner recreates the source LaunchAgent path",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      writeFileSync(harness.sourcePlist, "replacement owner\n", "utf8");
      const installedBinary = readFileSync(
        path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"),
      );

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );
      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain("could not restore the previous OpenClaw installation");
      expect(readFileSync(harness.sourcePlist, "utf8")).toBe("replacement owner\n");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        installedBinary,
      );
      expect(readFileSync(harness.launchStateFile, "utf8").trim()).toBe("elevation-loaded");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses recovery when a dangling symlink recreates the source LaunchAgent path",
    () => {
      const script = readFileSync(scriptPath, "utf8");
      const restoreBody = script.slice(
        script.indexOf("restore_file_without_overwrite()"),
        script.indexOf("verify_artifact_receipt()"),
      );
      expect(restoreBody).toContain('/bin/link "$restore_tmp" "$destination"');
      expect(restoreBody).not.toContain('ln "$restore_tmp" "$destination"');

      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);
      const installedBinary = readFileSync(
        path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"),
      );
      symlinkSync(path.join(harness.env.HOME, "missing-owner.plist"), harness.sourcePlist);

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );
      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain("could not restore the previous OpenClaw installation");
      expect(readFileSync(path.join(harness.appPath, "Contents", "MacOS", "OpenClaw"))).toEqual(
        installedBinary,
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "rejects a receipt backup path that lexically escapes the canonical state directory",
    () => {
      const harness = createInstallRollbackHarness({ launchdBootstrapFails: false });
      const installed = runInstaller(
        harness.installerPath,
        [
          "install",
          "--archive",
          harness.archivePath,
          "--receipt",
          harness.receiptPath,
          ...receiptDigestArgs(harness.receiptPath),
          "--app",
          harness.appPath,
          "--migrate-launch-agent",
          harness.sourcePlist,
        ],
        harness.env,
      );
      expect(installed.status, installed.stderr).toBe(0);

      const installReceiptPath = path.join(harness.stateDir, "elevation-host-install.json");
      const installReceipt = JSON.parse(readFileSync(installReceiptPath, "utf8")) as {
        migration: { backupPlist: string; backupSha256: string };
      };
      const deceptiveDirectory = path.join(
        harness.stateDir,
        `elevation-host.previous-launch-agent.${"a".repeat(40)}.ABCDEF`,
      );
      mkdirSync(deceptiveDirectory);
      const outsideBackup = path.join(harness.env.HOME, "outside-backup.plist");
      writeFileSync(outsideBackup, "attacker-selected\n", "utf8");
      installReceipt.migration.backupPlist = path.join(
        deceptiveDirectory,
        "..",
        "..",
        path.basename(outsideBackup),
      );
      installReceipt.migration.backupSha256 = sha256(readFileSync(outsideBackup));
      writeFileSync(installReceiptPath, JSON.stringify(installReceipt), "utf8");

      const recovered = runInstaller(
        harness.installerPath,
        ["recover", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );
      expect(recovered.status).toBe(1);
      expect(recovered.stderr).toContain("receipt migration plist backup path is not canonical");
      expect(readFileSync(outsideBackup, "utf8")).toBe("attacker-selected\n");
    },
  );

  it("treats missing TCC after a Bridge-ready install as degraded capability", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installBody = script.slice(
      script.indexOf("install_host()"),
      script.indexOf("recover_install()"),
    );
    const statusBody = script.slice(
      script.indexOf("status_host()"),
      script.indexOf("recover_host()"),
    );

    expect(installBody).toContain("tcc_summary || true");
    expect(statusBody).toContain("tcc_summary || return $?");
  });

  it("relaunches an adopted app only after exact exit with its selected state and config", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installBody = script.slice(
      script.indexOf("install_host()"),
      script.indexOf("recover_install()"),
    );
    const relaunchBody = script.slice(
      script.indexOf("relaunch_adopted_app()"),
      script.indexOf("run_openclaw_cli()"),
    );
    const recoverBody = script.slice(
      script.indexOf("recover_install()"),
      script.indexOf("status_host()"),
    );
    const recoverHostBody = script.slice(
      script.indexOf("recover_host()"),
      script.indexOf("uninstall_host()"),
    );

    expect(installBody.indexOf("CUTOVER_ADOPTION_STOPPED=1")).toBeLessThan(
      installBody.indexOf('kill "$ADOPTION_PID"'),
    );
    expect(installBody.indexOf("adopted_app_is_current || fail")).toBeLessThan(
      installBody.indexOf('kill "$ADOPTION_PID"'),
    );
    expect(relaunchBody).toContain('--env "OPENCLAW_STATE_DIR=$STATE_DIR"');
    expect(relaunchBody).toContain('--env "OPENCLAW_CONFIG_PATH=$CONFIG_PATH"');
    expect(relaunchBody).toContain("-g");
    expect(relaunchBody).toContain("wait_for_adopted_app_resume");
    expect(installBody.indexOf("CUTOVER_ADOPTION_TERMINATION_SENT=1")).toBeGreaterThan(
      installBody.indexOf('kill "$ADOPTION_PID"'),
    );
    expect(installBody.indexOf("CUTOVER_ADOPTION_TERMINATION_SENT=1")).toBeLessThan(
      installBody.indexOf("adopted OpenClaw process did not exit"),
    );
    expect(recoverBody).toContain("restore_adopted_app_after_cutover || recovery_failed=1");
    expect(recoverHostBody).toContain('CONFIG_PATH="$(jq -r \'.configPath\' "$RECEIPT_PATH")"');
  });

  it.each([
    ["fail", "TCC: unknown (permission probe failed)"],
    ["invalid", "TCC: unknown (permission probe returned invalid status)"],
  ] as const)(
    "fails closed when the TCC permission probe returns %s output",
    (mode, diagnostic) => {
      const harness = createStatusHarness(mode);
      const result = runInstaller(
        scriptPath,
        ["status", "--app", harness.appPath, "--state-dir", harness.stateDir],
        harness.env,
      );

      expect(result.status, result.stderr).toBe(4);
      expect(result.stdout).toContain("Elevation host ready: pid=4242");
      expect(result.stdout).toContain(diagnostic);
      expect(result.stdout).not.toContain("TCC: ready");
    },
  );

  it("builds an immutable source-addressed notarized ZIP with a portable installer", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'prefix="OpenClaw-${source_commit}-Peekaboo-${EXPECTED_PEEKABOO_SOURCE_COMMIT}-stable"',
    );
    expect(script).toContain("immutable elevation output already exists");
    expect(script).toContain("OPENCLAW_MAC_SIGNING_VARIANT=elevation-host");
    expect(script).toContain("SKIP_DMG=1");
    expect(script).toContain("NOTARY_RESULT_FILE");
    expect(script).toContain("archiveSha256");
    expect(script).toContain("archiveChecksum");
    expect(script).toContain('installer_path="$OUTPUT_DIR/${prefix}-installer.sh"');
    expect(script).toContain("installerSha256");
    expect(script).toContain("installerChecksum");
    expect(script).toContain("openclaw-elevation-artifact");
    expect(script).toContain("verify_artifact_receipt");
    expect(script).toContain(
      'git -C "$ROOT_DIR" show "${source_commit}:scripts/mac-elevation-host.sh"',
    );
    expect(script).toContain("portable installer does not match the selected source commit");
    expect(script).not.toContain("--elevation-installer");
    expect(script).toContain("notarizationId");
    expect(script).toContain("entitlementsSha256");
    expect(script).toContain("elevation archive root must contain exactly OpenClaw.app");
    expect(script).toContain("codesign --verify --strict --test-requirement='=notarized'");
    expect(script).toContain('spctl --assess --type execute "$app"');
  });

  it("keeps portable verification identity aligned with the signer", () => {
    const portableScript = readFileSync(scriptPath, "utf8");
    const codesignScript = readFileSync(codesignScriptPath, "utf8");
    const constant = (source: string, name: string) =>
      source.match(new RegExp(`^${name}="([^"]+)"$`, "m"))?.[1];

    expect(
      [
        constant(portableScript, "EXPECTED_TEAM_ID"),
        constant(portableScript, "EXPECTED_AUTHORITY"),
      ],
      "mac-elevation-host.sh verifies the signed app, so its duplicated signing constants must match codesign-mac-app.sh",
    ).toEqual([
      constant(codesignScript, "ELEVATION_TEAM_ID"),
      constant(codesignScript, "ELEVATION_IDENTITY"),
    ]);
  });

  it.skipIf(process.platform !== "darwin")(
    "renders a persistent background-only launchd job without changing normal login",
    () => {
      const tempRoot = tempDirs.make("openclaw-elevation-plist-");
      const stateDir = path.join(tempRoot, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const appPath = path.join(tempRoot, "OpenClaw.app");
      const result = spawnSync(
        "bash",
        [
          scriptPath,
          "print-plist",
          "--app",
          appPath,
          "--state-dir",
          stateDir,
          "--config-path",
          configPath,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, HOME: tempRoot, TMPDIR: tempRoot },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const plistPath = path.join(tempRoot, "rendered.plist");
      writeFileSync(plistPath, result.stdout, "utf8");
      const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
        encoding: "utf8",
      });
      expect(json.status, json.stderr).toBe(0);
      const plist = JSON.parse(json.stdout) as Record<string, unknown>;

      expect(plist.Label).toBe("ai.openclaw.mac.elevation-host");
      expect(plist.ProgramArguments).toEqual([
        `${appPath}/Contents/MacOS/OpenClaw`,
        "--elevation-host",
      ]);
      expect(plist.RunAtLoad).toBe(true);
      expect(plist.KeepAlive).toBe(true);
      expect(plist.EnvironmentVariables).toMatchObject({
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      });
    },
  );

  it("rejects non-absolute state paths before probing host tools", () => {
    const tempRoot = tempDirs.make("openclaw-elevation-input-");
    const result = runInstaller(scriptPath, ["status", "--state-dir", "relative/state"], {
      ...process.env,
      HOME: tempRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: --state-dir must be absolute");
  });
});
