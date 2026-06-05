// Parallels Npm Update Smoke tests cover parallels npm update smoke script behavior.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWindowsBackgroundPowerShell } from "../../scripts/e2e/parallels/guest-transports.ts";
import { run as hostCommandRun } from "../../scripts/e2e/parallels/host-command.ts";
import {
  macosUpdateScript,
  windowsUpdateScript,
} from "../../scripts/e2e/parallels/npm-update-scripts.ts";
import {
  freshLaneTimeoutMs,
  NpmUpdateSmoke,
  spawnLoggedCommand,
} from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import type { HostServer, Platform } from "../../scripts/e2e/parallels/types.ts";
import { withEnv, withEnvAsync } from "../../src/test-utils/env.js";

const SCRIPT_PATH = "scripts/e2e/parallels/npm-update-smoke.ts";
const GUEST_TRANSPORTS_PATH = "scripts/e2e/parallels/guest-transports.ts";
const UPDATE_SCRIPTS_PATH = "scripts/e2e/parallels/npm-update-scripts.ts";
const TEST_AUTH = {
  authChoice: "openai",
  authKeyFlag: "--openai-api-key",
  apiKeyEnv: "OPENAI_API_KEY",
  apiKeyValue: "test-key",
  modelId: "gpt-5.4",
};
const tempDirs: string[] = [];

function makeTempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-parallels-npm-update-"));
  tempDirs.push(root);
  return root;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for pid ${pid} to exit`);
}

function decodePowerShellFromArgs(args: string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : "";
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("parallels npm update smoke", () => {
  it("stops the host artifact server when the wrapper fails mid-run", async () => {
    let stopCalls = 0;
    const server: HostServer = {
      hostIp: "127.0.0.1",
      port: 48123,
      stop: async () => {
        stopCalls += 1;
      },
      urlFor: (filePath) => `http://127.0.0.1:48123/${path.basename(filePath)}`,
    };

    class FailingNpmUpdateSmoke extends NpmUpdateSmoke {
      protected override async makeRunTempDir(prefix: string): Promise<string> {
        void prefix;
        return makeTempDir();
      }

      protected override async runSteps(): Promise<void> {
        this.server = server;
        throw new Error("forced wrapper failure");
      }
    }

    await withEnvAsync({ OPENAI_API_KEY: "test-key" }, async () => {
      const smoke = new FailingNpmUpdateSmoke({
        ...TEST_AUTH,
        json: false,
        packageSpec: "openclaw@latest",
        platforms: new Set<Platform>(["linux"]),
        provider: "openai",
        updateTarget: "local-main",
      });

      await expect(smoke.run()).rejects.toThrow("forced wrapper failure");
    });

    expect(stopCalls).toBe(1);
  });

  it("has a one-command beta validation mode with fresh target coverage", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--beta-validation [target]");
    expect(script).toContain("resolveOpenClawRegistryVersion");
    expect(script).toContain("this.options.updateTarget = version");
    expect(script).toContain("this.options.freshTargetSpec = `openclaw@${version}`");
    expect(script).toContain("runFreshTargetInstalls");
    expect(script).toContain("freshTargetStatus");
  });

  it("guards beta validation against cross-version harness checkouts", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("assertPublishedTargetMatchesHarnessCheckout");
    expect(script).toContain("readHarnessCheckoutVersion");
    expect(script).toContain("openClawVersionFamily");
    expect(script).toContain("OPENCLAW_PARALLELS_ALLOW_HARNESS_TARGET_MISMATCH");
    expect(script).toContain("checkout the matching release branch");
  });

  it("lets callers override the Parallels host IP", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--host-ip <ip>");
    expect(script).toContain("hostIp?: string");
    expect(script).toContain("options.hostIp = ensureValue");
    expect(script).toContain('resolveHostIp(this.options.hostIp ?? "")');
  });

  it("prints actionable progress, rerun hints, and markdown summaries", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("stale=");
    expect(script).toContain("bytes=");
    expect(script).toContain("rerunCommand");
    expect(script).toContain("writeSummaryMarkdown");
    expect(script).toContain("Parallels NPM Update Smoke");
  });

  it("streams aggregate update logs instead of retaining them in memory", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const updateBlock = script.slice(
      script.indexOf("  private spawnUpdate"),
      script.indexOf("  private async runMacosUpdate"),
    );

    expect(updateBlock).toContain("appendFileSync(logPath, text");
    expect(updateBlock).toContain("run: ({ signal }) => fn({ append, logPath, signal })");
    expect(updateBlock).not.toContain("log += text");
  });

  it("streams fresh lane logs instead of retaining them in memory", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "fresh.log");
    const output: string[] = [];

    const code = await spawnLoggedCommand(
      process.execPath,
      ["-e", "process.stdout.write('fresh-out'); process.stderr.write('fresh-err');"],
      logPath,
      {},
      (text) => output.push(text),
      { timeoutMs: 1000 },
    );

    expect(code).toBe(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("fresh-out");
    expect(log).toContain("fresh-err");
    expect(output.join("")).toContain("fresh-out");
    expect(output.join("")).toContain("fresh-err");
  });

  it("sets platform-aware fresh lane timeouts", () => {
    withEnv({ OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: undefined }, () => {
      expect(freshLaneTimeoutMs("macos")).toBe(75 * 60 * 1000);
      expect(freshLaneTimeoutMs("linux")).toBe(75 * 60 * 1000);
      expect(freshLaneTimeoutMs("windows")).toBe(90 * 60 * 1000);
    });

    withEnv({ OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: "3" }, () => {
      expect(freshLaneTimeoutMs("macos")).toBe(3000);
    });
  });

  it.runIf(process.platform !== "win32")("times out fresh lane process groups", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "fresh.log");
    const scriptPath = path.join(root, "hung-fresh-lane.mjs");
    const descendantPidPath = path.join(root, "descendant.pid");
    const descendantScript = [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    writeFileSync(
      scriptPath,
      [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
          descendantScript,
        )}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const code = await spawnLoggedCommand(process.execPath, [scriptPath], logPath, {}, undefined, {
      timeoutKillGraceMs: 25,
      timeoutLabel: "fresh lane test",
      timeoutMs: 250,
    });

    expect(code).toBe(124);
    expect(readFileSync(logPath, "utf8")).toContain("fresh lane test timed out after 250ms");
    expect(existsSync(descendantPidPath)).toBe(true);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await waitForDead(descendantPid, 2000);
  });

  it("runs Windows updates through a detached done-file runner", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const transports = readFileSync(GUEST_TRANSPORTS_PATH, "utf8");

    expect(script).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(transports).toContain("${options.label} timed out");
  });

  it("cleans timed-out Windows background work and reads bounded log chunks", async () => {
    const decodedCommands: string[] = [];
    const fakeRun: typeof hostCommandRun = (_command, args) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (decoded.includes("Start-Process")) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        label: "windows background timeout",
        logChunkBytes: 64,
        pollIntervalMs: 1,
        runCommand: fakeRun,
        script: "Start-Sleep -Seconds 60",
        timeoutMs: 5,
        vmName: "Windows Test",
      }),
    ).rejects.toThrow("windows background timeout timed out");

    const commands = decodedCommands.join("\n---\n");
    expect(commands).toContain("$pidPath");
    expect(commands).toContain("Start-Process -FilePath powershell.exe");
    expect(commands).toContain("-PassThru");
    expect(commands).toContain("[System.IO.File]::Open($logPath");
    expect(commands).toContain("[Math]::Min($length - $offset, 64)");
    expect(commands).toContain("Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)");
    expect(commands).toContain(
      'Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId"',
    );
    expect(commands).toContain(
      "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
    );
    expect(commands).not.toContain("ReadAllBytes");
  });

  it("drains completed Windows background logs before cleanup", async () => {
    const decodedCommands: string[] = [];
    const output: string[] = [];
    let pollCount = 0;
    const fakeRun: typeof hostCommandRun = (_command, args) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (decoded.includes("Start-Process")) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (decoded.includes("__OPENCLAW_LOG_LENGTH__")) {
        pollCount += 1;
        return {
          status: 0,
          stderr: "",
          stdout:
            pollCount === 1
              ? [
                  "__OPENCLAW_LOG_LENGTH__:128",
                  "__OPENCLAW_LOG_OFFSET__:64",
                  "first chunk",
                  "__OPENCLAW_BACKGROUND_EXIT__:0",
                  "__OPENCLAW_BACKGROUND_DONE__",
                  "",
                ].join("\n")
              : [
                  "__OPENCLAW_LOG_LENGTH__:128",
                  "__OPENCLAW_LOG_OFFSET__:128",
                  "second chunk",
                  "__OPENCLAW_BACKGROUND_EXIT__:0",
                  "__OPENCLAW_BACKGROUND_DONE__",
                  "",
                ].join("\n"),
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        append: (chunk) => output.push(String(chunk)),
        completedLogDrainGraceMs: 1000,
        label: "windows background drain",
        logChunkBytes: 64,
        pollIntervalMs: 5000,
        runCommand: fakeRun,
        script: "Write-Output done",
        timeoutMs: 20,
        vmName: "Windows Test",
      }),
    ).resolves.toBeUndefined();

    expect(pollCount).toBe(2);
    expect(output.join("")).toContain("first chunk");
    expect(output.join("")).toContain("second chunk");
    expect(decodedCommands.join("\n")).not.toContain("Stop-OpenClawBackgroundProcessTree");
    expect(decodedCommands.join("\n")).toContain(
      "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
    );
  });

  it("keeps macOS sudo fallback update scripts readable by the desktop user", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('macosExecArgs.indexOf("-u")');
    expect(script).toContain('"/usr/sbin/chown", sudoUser, scriptPath');
  });

  it("scrubs future plugin entries before invoking old same-guest updaters", () => {
    const script = readFileSync(UPDATE_SCRIPTS_PATH, "utf8");
    const macosScript = macosUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });

    expect(script).toContain("Remove-FuturePluginEntries");
    expect(script).toContain("scrub_future_plugin_entries");
    expect(script).toContain("delete plugins.entries.feishu");
    expect(script).toContain("delete plugins.entries.whatsapp");
    expect(script).toContain("Remove-FuturePluginEntries\nStop-OpenClawGatewayProcesses");
    expect(script).toContain("scrub_future_plugin_entries\nstop_openclaw_gateway_processes");
    expect(script).toContain("Invoke-WithScopedEnv @{ OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'");
    expect(macosScript).toContain('OPENCLAW_BIN="$(resolve_required_command openclaw)"');
    expect(macosScript).toContain("/usr/local/bin:/usr/local/sbin");
    expect(macosScript).toContain(
      'OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 "$OPENCLAW_BIN" update --tag',
    );
    expect(macosScript).not.toContain("/opt/homebrew/bin/openclaw");
    expect(script).toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag");
    expect(macosScript).toContain(
      'OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 "$OPENCLAW_BIN" gateway stop',
    );
    expect(script).toContain(
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 OPENCLAW_ALLOW_ROOT=1 openclaw gateway stop",
    );
  });

  it("reenables bundled plugins before Windows post-update verification", () => {
    const script = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });

    const updateIndex = script.indexOf("Invoke-OpenClaw update --tag");
    const scopedIndex = script.indexOf("Invoke-WithScopedEnv @{ OPENCLAW_DISABLE_BUNDLED_PLUGINS");
    const versionIndex = script.indexOf("Invoke-OpenClaw --version", scopedIndex);
    const restartIndex = script.indexOf("Invoke-OpenClaw gateway restart");
    const agentIndex = script.indexOf("Invoke-OpenClaw agent --local");

    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(scopedIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(scopedIndex);
    expect(versionIndex).toBeGreaterThan(updateIndex);
    expect(restartIndex).toBeGreaterThan(updateIndex);
    expect(agentIndex).toBeGreaterThan(updateIndex);
    expect(script).not.toContain("$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'");
  });

  it("generates a .NET-safe Windows stale import regex in the update-failure guard", () => {
    const script = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.4.30",
      updateTarget: "latest",
    });
    const staleImportLine = script.match(/\$stalePostSwapImport = [^\n]+/)?.[0];
    const staleImportMatch = script.match(/\$updateText -match '(node_modules[^']+)'/);
    const staleImportPattern = staleImportMatch?.[1];

    if (!staleImportLine) {
      throw new Error("missing generated Windows stale import guard");
    }
    if (!staleImportPattern) {
      throw new Error("missing generated Windows stale import regex");
    }
    expect(staleImportLine).toContain("$updateText -match 'ERR_MODULE_NOT_FOUND'");
    expect(staleImportLine).toContain(`$updateText -match '${staleImportPattern}'`);
    expect(staleImportPattern).toBe(
      String.raw`node_modules\\openclaw\\dist\\[^\\]+-[A-Za-z0-9_-]+\.js`,
    );
    expect(staleImportPattern).not.toContain("node_modules\\openclaw\\dist\\");
    expect(staleImportPattern.match(/\\\\/g)).toHaveLength(4);
    const representativeUpdateFailure = String.raw`Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\main-a1_B2.js' imported from C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\cli.js`;
    const generatedRegex = new RegExp(staleImportPattern);
    expect(generatedRegex.test(representativeUpdateFailure)).toBe(true);
    expect(generatedRegex.test(String.raw`node_modules\openclaw\dist\main.js`)).toBe(false);
  });
});
