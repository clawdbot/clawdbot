import { spawnSync } from "node:child_process";
// Mac Elevation Host tests protect the unattended launchd and artifact contracts.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function createStatusHarness(permissionMode: "fail" | "invalid") {
  const tempRoot = tempDirs.make(`openclaw-elevation-status-${permissionMode}-`);
  const binDir = path.join(tempRoot, "bin");
  const appPath = path.join(tempRoot, "OpenClaw.app");
  const stateDir = path.join(tempRoot, "state");
  const launchAgentsDir = path.join(tempRoot, "Library", "LaunchAgents");
  mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture", "utf8");
  writeFileSync(
    path.join(launchAgentsDir, "ai.openclaw.mac.elevation-host.plist"),
    "fixture",
    "utf8",
  );

  writeExecutable(
    path.join(binDir, "codesign"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "$*" == *"--entitlements"* ]]; then',
      "  printf '%s\\n' '<plist><dict/></plist>'",
      "  exit 0",
      "fi",
      'if [[ "$*" == *"-dv"* ]]; then',
      "  printf '%s\\n' 'Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' >&2",
      "  printf '%s\\n' 'TeamIdentifier=FWJYW4S8P8' >&2",
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
      '  ProgramArguments) printf \'["%s/Contents/MacOS/OpenClaw","--elevation-host"]\\n\' "$TEST_APP_PATH" ;;',
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
      TEST_PEEKABOO_MODE: permissionMode,
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
    expect(result.stdout).toContain("package [--output-dir <dir>]");
    expect(result.stdout).toContain("install --archive <zip>");
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
    expect(script).toContain("previous installation restored");
    expect(script).not.toContain("osascript");
  });

  it("runs a copied lifecycle installer without a source checkout", () => {
    const tempRoot = tempDirs.make("openclaw-elevation-uninstall-");
    const binDir = path.join(tempRoot, "bin");
    const installerPath = path.join(tempRoot, "portable-installer.sh");
    mkdirSync(binDir);
    writeExecutable(installerPath, readFileSync(scriptPath, "utf8"));
    const launchctl = path.join(binDir, "launchctl");
    writeFileSync(launchctl, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(launchctl, 0o755);

    const result = spawnSync("/bin/bash", [installerPath, "uninstall"], {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        HOME: tempRoot,
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Elevation launch agent removed");
  });

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

  it.each([
    ["fail", "TCC: unknown (permission probe failed)"],
    ["invalid", "TCC: unknown (permission probe returned invalid status)"],
  ] as const)(
    "fails closed when the TCC permission probe returns %s output",
    (mode, diagnostic) => {
      const harness = createStatusHarness(mode);
      const result = spawnSync(
        "/bin/bash",
        [scriptPath, "status", "--app", harness.appPath, "--state-dir", harness.stateDir],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: harness.env,
        },
      );

      expect(result.status, result.stderr).toBe(4);
      expect(result.stdout).toContain("Elevation host ready: pid=4242");
      expect(result.stdout).toContain(diagnostic);
      expect(result.stdout).not.toContain("TCC: ready");
    },
  );

  it("builds an immutable source-addressed notarized ZIP and receipt", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('prefix="OpenClaw-${source_commit}-stable"');
    expect(script).toContain("immutable elevation output already exists");
    expect(script).toContain("OPENCLAW_MAC_SIGNING_VARIANT=elevation-host");
    expect(script).toContain("SKIP_DMG=1");
    expect(script).toContain("NOTARY_RESULT_FILE");
    expect(script).toContain("archiveSha256");
    expect(script).toContain("archiveChecksum");
    expect(script).toContain('installer_path="$OUTPUT_DIR/${prefix}-installer.sh"');
    expect(script).toContain("installerSha256");
    expect(script).toContain("installerChecksum");
    expect(script).toContain(
      'git -C "$ROOT_DIR" show "${source_commit}:scripts/mac-elevation-host.sh"',
    );
    expect(script).toContain("portable installer does not match the selected source commit");
    expect(script).toContain("notarizationId");
    expect(script).toContain("entitlementsSha256");
    expect(script).toContain("elevation archive root must contain exactly OpenClaw.app");
    expect(script).toContain("codesign --verify --strict --test-requirement='=notarized'");
    expect(script).toContain('spctl --assess --type execute "$app"');
  });

  it("keeps portable signing identity aligned with the signer", () => {
    const portableScript = readFileSync(scriptPath, "utf8");
    const codesignScript = readFileSync(codesignScriptPath, "utf8");
    const constant = (source: string, name: string) =>
      source.match(new RegExp(`^${name}="([^"]+)"$`, "m"))?.[1];

    expect(
      [
        constant(portableScript, "EXPECTED_TEAM_ID"),
        constant(portableScript, "EXPECTED_AUTHORITY"),
      ],
      "mac-elevation-host.sh is a self-contained portable installer, so its duplicated signing constants must match codesign-mac-app.sh",
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
    const result = spawnSync("bash", [scriptPath, "status", "--state-dir", "relative/state"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: tempRoot },
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: --state-dir must be absolute");
  });
});
