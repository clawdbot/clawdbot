// Parallels Npm Update Smoke tests cover parallels npm update smoke script behavior.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWindowsBackgroundPowerShell } from "../../scripts/e2e/parallels/guest-transports.ts";
import { run as hostCommandRun } from "../../scripts/e2e/parallels/host-command.ts";
import {
  linuxUpdateScript,
  macosUpdateScript,
  windowsUpdateScript,
} from "../../scripts/e2e/parallels/npm-update-scripts.ts";
import {
  freshLaneTimeoutMs,
  NpmUpdateSmoke,
  parseRegistryPackageMetadata,
  parseArgs,
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timeout waiting for ${label}`);
}

function decodePowerShellFromArgs(args: string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : "";
}

function extractWindowsBackgroundControlMarkers(decoded: string): {
  done: string;
  exitPrefix: string;
} {
  const marker = (name: string, trailingColon: boolean): string => {
    const suffix = trailingColon ? ":" : "";
    const match = decoded.match(new RegExp(`${name}:[A-Za-z0-9_-]+${suffix}`));
    if (!match) {
      throw new Error(`missing ${name} control marker`);
    }
    return match[0];
  };
  return {
    done: marker("__OPENCLAW_BACKGROUND_DONE__", false),
    exitPrefix: marker("__OPENCLAW_BACKGROUND_EXIT__", true),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("parallels npm update smoke", () => {
  it("accepts one prepared tarball target for update and fresh install", () => {
    expect(
      parseArgs([
        "--target-tarball",
        "/tmp/openclaw-candidate.tgz",
        "--dependency-tarball",
        "/tmp/openclaw-ai-candidate.tgz",
      ]),
    ).toMatchObject({
      dependencyTarballs: ["/tmp/openclaw-ai-candidate.tgz"],
      targetTarball: "/tmp/openclaw-candidate.tgz",
      updateTarget: "",
      freshTargetSpec: undefined,
    });
    expect(() =>
      parseArgs(["--target-tarball", "/tmp/openclaw-candidate.tgz", "--update-target", "beta"]),
    ).toThrow("--target-tarball cannot be combined");
    expect(() => parseArgs(["--dependency-tarball", "/tmp/openclaw-ai-candidate.tgz"])).toThrow(
      "--dependency-tarball requires --target-tarball",
    );
  });

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
        dependencyTarballs: [],
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

  it("removes uploaded guest update scripts when chmod fails", () => {
    const root = makeTempDir();
    const logPath = path.join(root, "prlctl.log");
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(logPath)}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
if [[ "$args" == *" /usr/bin/tee /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  cat >/dev/null
  exit 0
fi
if [[ "$args" == *" /bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  echo "chmod denied" >&2
  exit 7
fi
if [[ "$args" == *" /bin/rm -f /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  printf 'cleanup\\n' >>"$log_path"
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["linux"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const writeGuestScript = Reflect.get(smoke, "writeGuestScript") as (
          vm: string,
          script: string,
          prefix: string,
        ) => string;

        expect(() =>
          writeGuestScript.call(
            smoke,
            "Linux VM",
            "echo update",
            "openclaw-parallels-npm-update-linux",
          ),
        ).toThrow("failed to chmod guest script");
      },
    );

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("/bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-");
    expect(log).toContain("/bin/rm -f /tmp/openclaw-parallels-npm-update-linux-");
    expect(log.match(/^cleanup$/gm)).toHaveLength(1);
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

  it("serves a prepared package set for both proof phases", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--target-tarball <path>");
    expect(script).toContain("--dependency-tarball <path>");
    expect(script).toContain('label: "prepared candidate tgz"');
    expect(script).toContain("await copyFile(this.targetTarballPath, hostedTarballPath)");
    expect(script).toContain("startNpmRegistryServer");
    expect(script).toContain("this.updateTargetEffective = this.targetTarballVersion");
    expect(script).toContain("this.freshTargetSpec = this.updateTargetTarball");
    expect(script).toContain("this.updateExpectedNeedle = this.targetTarballVersion");
  });

  it("routes update installs through the prepared package registry", () => {
    const registry = "http://192.0.2.2:48123";
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.7.1-beta.3",
      npmRegistry: registry,
      updateTarget: "2026.7.1-beta.3",
    };

    expect(macosUpdateScript(input)).toContain(`NPM_CONFIG_REGISTRY='${registry}'`);
    expect(linuxUpdateScript(input)).toContain(`NPM_CONFIG_REGISTRY='${registry}'`);
    expect(windowsUpdateScript(input)).toContain(`NPM_CONFIG_REGISTRY = '${registry}'`);
  });

  it("accepts keyed and nested npm metadata for published update targets", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("curl -fsSL --connect-timeout 10 --max-time 120 --retry 2");
    expect(script).toContain("timeoutMs: 150_000");

    expect(
      parseRegistryPackageMetadata(
        JSON.stringify({
          version: "2026.5.20-beta.1",
          "dist.tarball": "https://registry.example/openclaw-keyed.tgz",
          gitHead: "abcdef0123456789",
        }),
      ),
    ).toEqual({
      version: "2026.5.20-beta.1",
      tarball: "https://registry.example/openclaw-keyed.tgz",
      gitHead: "abcdef0123456789",
    });

    expect(
      parseRegistryPackageMetadata(
        JSON.stringify({
          version: "2026.5.20-beta.1",
          dist: { tarball: "https://registry.example/openclaw-nested.tgz" },
        }),
      ),
    ).toEqual({
      version: "2026.5.20-beta.1",
      tarball: "https://registry.example/openclaw-nested.tgz",
      gitHead: "",
    });
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

  it("bounds POSIX guest failure logs", () => {
    const scripts = [
      macosUpdateScript({
        auth: TEST_AUTH,
        expectedNeedle: "2026.5.3-beta.2",
        updateTarget: "2026.5.3-beta.2",
      }),
      linuxUpdateScript({
        auth: TEST_AUTH,
        expectedNeedle: "2026.5.3-beta.2",
        updateTarget: "2026.5.3-beta.2",
      }),
    ].join("\n");

    expect(scripts).toContain("print_log_tail()");
    expect(scripts).toContain("OPENCLAW_PARALLELS_NPM_UPDATE_LOG_TAIL_BYTES");
    expect(scripts).toContain('print_log_tail "$output_file"');
    expect(scripts).toContain("print_log_tail /tmp/openclaw-parallels-macos-gateway.log >&2");
    expect(scripts).toContain("print_log_tail /tmp/openclaw-parallels-linux-gateway.log >&2");
    expect(scripts).not.toContain('cat "$output_file"');
    expect(scripts).not.toContain("cat /tmp/openclaw-parallels-");
  });

  it("passes platform model timeouts to POSIX update agent turns", () => {
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    };
    withEnv(
      {
        OPENCLAW_PARALLELS_LINUX_MODEL_TIMEOUT_S: undefined,
        OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: undefined,
        OPENCLAW_PARALLELS_MODEL_TIMEOUT_S: undefined,
      },
      () => {
        expect(macosUpdateScript(input)).toContain("--timeout 1800 --json");
        expect(linuxUpdateScript(input)).toContain("--timeout 900 --json");
      },
    );
    withEnv(
      {
        OPENCLAW_PARALLELS_LINUX_MODEL_TIMEOUT_S: "321",
        OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: "654",
      },
      () => {
        expect(macosUpdateScript(input)).toContain("--timeout 654 --json");
        expect(linuxUpdateScript(input)).toContain("--timeout 321 --json");
      },
    );
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

    withEnv(
      { OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: String(Number.MAX_SAFE_INTEGER) },
      () => {
        expect(freshLaneTimeoutMs("linux")).toBe(MAX_TIMER_TIMEOUT_MS);
      },
    );
  });

  it("clamps oversized fresh lane command timeouts before scheduling", async () => {
    const root = makeTempDir();
    const logPath = path.join(root, "fresh.log");

    const code = await spawnLoggedCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 25);"],
      logPath,
      {},
      undefined,
      { timeoutMs: Number.MAX_SAFE_INTEGER },
    );

    expect(code).toBe(0);
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

  it.runIf(process.platform !== "win32")(
    "lets fresh lane descendants exit during timeout kill grace",
    async () => {
      const root = makeTempDir();
      const logPath = path.join(root, "fresh.log");
      const scriptPath = path.join(root, "graceful-fresh-lane.mjs");
      const readyPath = path.join(root, "ready");
      const donePath = path.join(root, "done");
      const descendantScript = [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
        "});",
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

      const command = spawnLoggedCommand(process.execPath, [scriptPath], logPath, {}, undefined, {
        timeoutKillGraceMs: 500,
        timeoutLabel: "fresh lane grace test",
        timeoutMs: 500,
      });

      await waitFor(() => existsSync(readyPath), "fresh lane descendant readiness");
      await expect(command).resolves.toBe(124);
      expect(readFileSync(donePath, "utf8")).toBe("done");
    },
  );

  it("clears update stream timers when spawning the guest command fails", async () => {
    vi.useFakeTimers();
    const smoke = withEnv(
      { OPENAI_API_KEY: "test-key" },
      () =>
        new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["linux"]),
          provider: "openai",
          updateTarget: "local-main",
        }),
    );
    const runStreamingToJobLog = Reflect.get(smoke, "runStreamingToJobLog") as (
      command: string,
      args: string[],
      timeoutMs: number,
      ctx: {
        append(chunk: string | Uint8Array): void;
        logPath: string;
        signal: AbortSignal;
      },
    ) => Promise<number>;

    await expect(
      runStreamingToJobLog.call(smoke, "openclaw-definitely-missing-command", [], 60 * 60 * 1000, {
        append: () => undefined,
        logPath: "",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "lets update stream descendants exit during timeout kill grace",
    async () => {
      const root = makeTempDir();
      const scriptPath = path.join(root, "stream-update-grace.mjs");
      const readyPath = path.join(root, "stream-ready");
      const donePath = path.join(root, "stream-done");
      const smoke = withEnv(
        { OPENAI_API_KEY: "test-key" },
        () =>
          new NpmUpdateSmoke({
            ...TEST_AUTH,
            dependencyTarballs: [],
            json: false,
            packageSpec: "openclaw@latest",
            platforms: new Set<Platform>(["linux"]),
            provider: "openai",
            updateTarget: "local-main",
          }),
      );
      const runStreamingToJobLog = Reflect.get(smoke, "runStreamingToJobLog") as (
        command: string,
        args: string[],
        timeoutMs: number,
        ctx: {
          append(chunk: string | Uint8Array): void;
          logPath: string;
          signal: AbortSignal;
        },
      ) => Promise<number>;
      const descendantScript = [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
        "});",
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

      const command = runStreamingToJobLog.call(smoke, process.execPath, [scriptPath], 500, {
        append: () => undefined,
        logPath: path.join(root, "update.log"),
        signal: new AbortController().signal,
      });

      await waitFor(() => existsSync(readyPath), "update stream descendant readiness");
      await expect(command).resolves.toBe(124);
      expect(readFileSync(donePath, "utf8")).toBe("done");
    },
  );

  it("runs Windows updates through a detached done-file runner", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const transports = readFileSync(GUEST_TRANSPORTS_PATH, "utf8");

    expect(script).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(transports).toContain("${options.label} timed out");
  });

  it("cleans timed-out Windows background work", async () => {
    const decodedCommands: string[] = [];
    const inputs: string[] = [];
    const fakeRun: typeof hostCommandRun = (_command, args, options) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (options?.input) {
        inputs.push(options.input);
      }
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        return { status: 0, stderr: "", stdout: "wait\n" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        label: "windows background timeout",
        pollIntervalMs: 1,
        runCommand: fakeRun,
        script: "Start-Sleep -Seconds 60",
        timeoutMs: 5,
        vmName: "Windows Test",
      }),
    ).rejects.toThrow("windows background timeout timed out");

    const commands = decodedCommands.join("\n---\n");
    const payloads = inputs.join("\n---\n");
    expect(commands).toContain("$pidPath");
    expect(commands).toContain("function Write-OpenClawUtf8File");
    expect(commands).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(payloads).toContain("Write-OpenClawUtf8File $exitPath '0'");
    expect(payloads).toContain("Write-OpenClawUtf8File $donePath 'done'");
    expect(payloads).toContain("Write-OpenClawUtf8File $pidPath ([string]$PID)");
    expect(commands).toContain('cmd.exe /d /s /c start "" /b powershell.exe');
    expect(commands).toContain("icacls.exe $runDir /inheritance:r");
    expect(commands).toContain("Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)");
    expect(commands).toContain(
      'Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId"',
    );
    expect(commands).toContain(
      "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
    );
    expect(`${commands}\n${payloads}`).not.toContain("Set-Content -Path $exitPath");
    expect(`${commands}\n${payloads}`).not.toContain("Set-Content -Path $donePath");
    expect(commands).not.toContain("Set-Content -Path $pidPath");
    expect(commands).not.toContain("ReadAllBytes");
  });

  it("does not treat Windows background log text as completion control", async () => {
    const decodedCommands: string[] = [];
    const fakeRun: typeof hostCommandRun = (_command, args) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        return { status: 0, stderr: "", stdout: "done\n" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        label: "windows background marker smuggle",
        pollIntervalMs: 1,
        runCommand: fakeRun,
        script: "Write-Output done",
        timeoutMs: 5,
        completedLogDrainGraceMs: 5,
        vmName: "Windows Test",
      }),
    ).rejects.toThrow("windows background marker smuggle timed out");

    expect(decodedCommands.join("\n")).toContain(
      "Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)",
    );
  });

  it("drains completed Windows background logs before cleanup", async () => {
    const decodedCommands: string[] = [];
    const output: string[] = [];
    let pollCount = 0;
    const fakeRun: typeof hostCommandRun = (_command, args) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        const command = args.at(-1) ?? "";
        if (command.includes("type")) {
          pollCount += 1;
          const markers = extractWindowsBackgroundControlMarkers(command);
          return {
            status: 0,
            stderr: "",
            stdout: ["first chunk", `${markers.exitPrefix}0`, markers.done, ""].join("\n"),
          };
        }
        if (command.includes("if exist")) {
          return { status: 0, stderr: "", stdout: "done\n" };
        }
        return { status: 0, stderr: "", stdout: "" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        append: (chunk) => output.push(String(chunk)),
        completedLogDrainGraceMs: 1000,
        label: "windows background drain",
        pollIntervalMs: 5000,
        runCommand: fakeRun,
        script: "Write-Output done",
        timeoutMs: 20,
        vmName: "Windows Test",
      }),
    ).resolves.toBeUndefined();

    expect(pollCount).toBe(1);
    expect(output.join("")).toContain("first chunk");
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

  it("selects macOS desktop users with homes on spaced mounted volumes", () => {
    const root = makeTempDir();
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
args=" $* "
if [[ "$args" == *" /usr/bin/stat -f %Su /dev/console"* ]]; then
  printf '%s\\n' 'loginwindow'
  exit 0
fi
if [[ "$args" == *" /usr/bin/dscl . -list /Users NFSHomeDirectory"* ]]; then
  printf '%s\\n' '_daemon /var/root'
  printf '%s\\n' 'clawuser /Volumes/Macintosh HD/Users/clawuser'
  exit 0
fi
exit 7
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["macos"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const resolveMacosDesktopUser = Reflect.get(
          smoke,
          "resolveMacosDesktopUser",
        ) as () => string;

        expect(resolveMacosDesktopUser.call(smoke)).toBe("clawuser");
      },
    );
  });

  it("keeps spaces in macOS sudo fallback desktop homes", () => {
    const root = makeTempDir();
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
args=" $* "
if [[ "$args" == *" /usr/bin/dscl . -read /Users/clawuser NFSHomeDirectory"* ]]; then
  printf '%s\\n' 'NFSHomeDirectory: /Volumes/Macintosh HD/Users/clawuser'
  exit 0
fi
exit 7
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["macos"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const resolveMacosDesktopHome = Reflect.get(smoke, "resolveMacosDesktopHome") as (
          user: string,
        ) => string;

        expect(resolveMacosDesktopHome.call(smoke, "clawuser")).toBe(
          "/Volumes/Macintosh HD/Users/clawuser",
        );
      },
    );
  });

  it("scrubs future plugin entries before invoking old same-guest updaters", () => {
    const script = readFileSync(UPDATE_SCRIPTS_PATH, "utf8");
    const windowsScript = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });
    const macosScript = macosUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });

    expect(script).toContain("Remove-FuturePluginEntries");
    expect(script).toContain("scrub_future_plugin_entries");
    expect(script).toContain("delete plugins.entries.feishu");
    expect(script).toContain("delete plugins.entries.whatsapp");
    expect(windowsScript).toContain(
      'const futurePluginIds = new Set(["feishu", "whatsapp", "openai"])',
    );
    expect(windowsScript).toContain('replace(/^\\uFEFF/u, "")');
    expect(windowsScript).toContain("if (allow.length !== plugins.allow.length)");
    expect(windowsScript).toContain('JSON.stringify(config, null, 2) + "\\n"');
    expect(windowsScript).not.toContain("ConvertTo-Json -Depth 100");
    expect(windowsScript).toContain("& node.exe $nodeScriptPath $configPath");
    expect(windowsScript).toContain(
      "Remove-Item $nodeScriptPath -Force -ErrorAction SilentlyContinue",
    );
    expect(windowsScript).toContain("Remove-FuturePluginEntries\nStop-OpenClawGatewayProcesses");
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
