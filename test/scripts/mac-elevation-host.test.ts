import { spawnSync } from "node:child_process";
// Mac Elevation Host tests protect the unattended launchd and artifact contracts.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/mac-elevation-host.sh";

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

  it("scopes prerequisites to each lifecycle command", () => {
    const tempRoot = tempDirs.make("openclaw-elevation-uninstall-");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(binDir);
    const launchctl = path.join(binDir, "launchctl");
    writeFileSync(launchctl, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(launchctl, 0o755);

    const result = spawnSync("/bin/bash", [scriptPath, "uninstall"], {
      cwd: process.cwd(),
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

  it("builds an immutable source-addressed notarized ZIP and receipt", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('prefix="OpenClaw-${source_commit}-stable"');
    expect(script).toContain("immutable elevation output already exists");
    expect(script).toContain("OPENCLAW_MAC_SIGNING_VARIANT=elevation-host");
    expect(script).toContain("SKIP_DMG=1");
    expect(script).toContain("NOTARY_RESULT_FILE");
    expect(script).toContain("archiveSha256");
    expect(script).toContain("notarizationId");
    expect(script).toContain("entitlementsSha256");
    expect(script).toContain("elevation archive root must contain exactly OpenClaw.app");
    expect(script).toContain("codesign --verify --strict --test-requirement='=notarized'");
    expect(script).toContain('spctl --assess --type execute "$app"');
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
