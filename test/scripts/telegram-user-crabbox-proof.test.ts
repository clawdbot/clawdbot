// Telegram User Crabbox Proof tests cover telegram user crabbox proof script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  createOpenClawGatewaySpawnSpec,
  parseArgs,
  readLogTail,
  readTelegramUserProofLogTailBytes,
  recordProbeVideo,
  REMOTE_SETUP_COMMAND_TIMEOUT_MS,
  renderLaunchDesktop,
  renderRemoteProbe,
  renderRemoteSetup,
  renderSelectDesktopChat,
  runCommand,
  signalCommandTree,
  stageFullSessionArtifacts,
  startLocalSut,
  waitForLog,
} from "../../scripts/e2e/telegram-user-crabbox-proof.ts";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";

const tempDirs: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-proof-"));
  tempDirs.push(dir);
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeExecutable(pathname: string, content: string): void {
  fs.writeFileSync(pathname, content, { mode: 0o755 });
}

function runProofCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/e2e/telegram-user-crabbox-proof.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("condition was not met before timeout");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("telegram user Crabbox proof log polling", () => {
  it("starts the local gateway through the repo pnpm runner", () => {
    const root = makeTempDir();
    const fakePnpm = path.join(root, "pnpm.cjs");
    fs.writeFileSync(fakePnpm, "#!/usr/bin/env node\n", { mode: 0o755 });

    const spec = createOpenClawGatewaySpawnSpec({
      env: { ...process.env, OPENCLAW_TELEGRAM_PROOF_SENTINEL: "1" },
      gatewayPort: 19042,
      nodeExecPath: "/opt/node/bin/node",
      npmExecPath: fakePnpm,
      repoRoot: root,
    });

    expect(spec.command).toBe("/opt/node/bin/node");
    expect(spec.args).toEqual([fakePnpm, "openclaw", "gateway", "--port", "19042"]);
    expect(spec.options.cwd).toBe(root);
    expect(spec.options.env?.OPENCLAW_TELEGRAM_PROOF_SENTINEL).toBe("1");
    expect(spec.options.shell).toBe(false);
  });

  it("allows cold remote setup to outlive ordinary command timeouts", () => {
    expect(REMOTE_SETUP_COMMAND_TIMEOUT_MS).toBeGreaterThan(COMMAND_TIMEOUT_MS);
    expect(REMOTE_SETUP_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(90 * 60 * 1000);
  });

  it("rejects loose numeric log tail limits instead of parsing prefixes", () => {
    expect(() =>
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: 1e3");
    expect(() =>
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "1000bytes",
      }),
    ).toThrow("invalid OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: 1000bytes");
    expect(
      readTelegramUserProofLogTailBytes({
        OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES: "4096",
      }),
    ).toBe(4096);
  });

  it.each([
    ["loose gateway", "--gateway-port", "1e3", "--gateway-port must be a positive integer."],
    [
      "out-of-range gateway",
      "--gateway-port",
      "65536",
      "--gateway-port must be a TCP port from 1 to 65535.",
    ],
    [
      "out-of-range mock",
      "--mock-port",
      "65536",
      "--mock-port must be a TCP port from 1 to 65535.",
    ],
  ])("rejects %s proof ports before remote setup", (_label, flag, value, message) => {
    expect(() => parseArgs([flag, value, "--dry-run"])).toThrow(message);
  });

  it("rejects short flags as proof option values before dry-run planning", () => {
    const result = runProofCli(["--output-dir", "-h", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("keeps hyphen-prefixed free-text proof values", () => {
    expect(parseArgs(["--text", "-ping"]).text).toBe("-ping");
  });

  it("rejects duplicate single-value proof controls while keeping repeated expectations", () => {
    expect(() =>
      parseArgs(["--output-dir", ".artifacts/one", "--output-dir", ".artifacts/two"]),
    ).toThrow("--output-dir was provided more than once");

    expect(parseArgs(["--expect", "OpenClaw", "--expect", "ready"]).expect).toEqual([
      "OpenClaw",
      "ready",
    ]);
  });

  it("uses unique default output dirs", () => {
    const firstOutputDir = parseArgs([]).outputDir;
    const secondOutputDir = parseArgs([]).outputDir;

    expect(path.dirname(firstOutputDir)).toBe(
      path.join(".artifacts", "qa-e2e", "telegram-user-crabbox"),
    );
    expect(path.basename(firstOutputDir)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u,
    );
    expect(secondOutputDir).not.toBe(firstOutputDir);
    expect(parseArgs(["--output-dir", ".artifacts/custom"]).outputDir).toBe(".artifacts/custom");
  });

  it("clamps proof timeout args before they reach Node timers", () => {
    expect(parseArgs(["--timeout-ms", String(MAX_TIMER_TIMEOUT_MS + 1)]).timeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("reads only the requested log tail", () => {
    const logPath = path.join(makeTempDir(), "gateway.log");
    fs.writeFileSync(logPath, `${"old\n".repeat(2000)}ready\n`, "utf8");

    const tail = readLogTail(logPath, 32);

    expect(tail).toContain("ready");
    expect(tail.length).toBeLessThanOrEqual(32);
    expect(tail).not.toContain("old\nold\nold\nold\nold\nold\nold\nold\nold");
  });

  it("honors short reads when a log shrinks during tailing", () => {
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
      size: 64,
    } as fs.Stats);
    vi.spyOn(fs, "openSync").mockReturnValue(123 as never);
    vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => {
      if (!Buffer.isBuffer(buffer)) {
        throw new Error("expected buffer read");
      }
      buffer.write("ready");
      return 5;
    });

    expect(readLogTail("/tmp/truncated.log", 64)).toBe("ready");
  });

  it("does not reread the full log while waiting for readiness", async () => {
    const logPath = path.join(makeTempDir(), "mock-openai.log");
    fs.writeFileSync(logPath, `${"noise\n".repeat(2000)}mock-openai listening\n`, "utf8");
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("full log read");
    });

    await waitForLog(logPath, /mock-openai listening/u, "mock-openai", 100);

    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("reports only a bounded log tail on timeout", async () => {
    const logPath = path.join(makeTempDir(), "gateway.log");
    fs.writeFileSync(logPath, `old-secret\n${"x".repeat(300_000)}recent failure\n`, "utf8");

    let message = "";
    try {
      await waitForLog(logPath, /\[gateway\] ready/u, "gateway", 0);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("recent failure");
    expect(message).not.toContain("old-secret");
  });

  it("bounds remote Telegram Desktop launch diagnostics", () => {
    const script = renderLaunchDesktop();

    expect(script).toContain("print_desktop_log_tail() {");
    expect(script).toContain('tail -c 262144 "$log_file"');
    expect(script).toContain("print_desktop_log_tail\n  exit 1");
    expect(script).not.toContain('cat "$root/telegram-desktop.log"');
  });

  it("shell-quotes generated remote setup and chat literals", () => {
    const payload = "name $(touch /tmp/openclaw-proof-injected) `touch /tmp/also-injected`";

    expect(renderRemoteSetup({ tdlibSha256: payload, tdlibUrl: payload })).toContain(
      `tdlib_url='${payload}'`,
    );
    expect(renderSelectDesktopChat({ chatTitle: payload })).toContain(`chat_title='${payload}'`);
  });

  it("stages full publish artifacts without session control files", () => {
    const outputDir = makeTempDir();
    const publishDir = path.join(outputDir, "publish-full-artifacts");
    fs.mkdirSync(publishDir);
    fs.writeFileSync(path.join(publishDir, "stale.txt"), "stale");
    fs.mkdirSync(path.join(outputDir, "publish-gif-only"));
    fs.writeFileSync(
      path.join(outputDir, "session.json"),
      '{"sshKey":"/private/tmp/openclaw/key"}',
    );
    fs.writeFileSync(path.join(outputDir, "lease.json"), '{"token":"secret"}');
    fs.writeFileSync(path.join(outputDir, "status.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "probe.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "probe-2026-06-20T16-47-48-123Z.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "probe-secret.json"), '{"token":"secret"}');
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-session-summary.json"), "{}");
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-proof.md"), "report");
    fs.writeFileSync(path.join(outputDir, "telegram-desktop.log"), "log");
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-session-motion.gif"), "gif");
    fs.writeFileSync(path.join(outputDir, "telegram-user-crabbox-session.mp4"), "video");

    const stagedDir = stageFullSessionArtifacts(outputDir);

    expect(stagedDir).toBe(publishDir);
    expect(fs.readdirSync(stagedDir).toSorted()).toEqual([
      "probe-2026-06-20T16-47-48-123Z.json",
      "probe.json",
      "status.json",
      "telegram-desktop.log",
      "telegram-user-crabbox-proof.md",
      "telegram-user-crabbox-session-motion.gif",
      "telegram-user-crabbox-session-summary.json",
      "telegram-user-crabbox-session.mp4",
    ]);
    expect(fs.existsSync(path.join(stagedDir, "session.json"))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, "lease.json"))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, "probe-secret.json"))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, "stale.txt"))).toBe(false);
  });

  it("requires finish to write the proof report before full artifact publishing", () => {
    const outputDir = makeTempDir();
    fs.writeFileSync(
      path.join(outputDir, "session.json"),
      '{"sshKey":"/private/tmp/openclaw/key"}',
    );
    fs.writeFileSync(path.join(outputDir, "status.json"), '{"ok":true}');
    fs.writeFileSync(path.join(outputDir, "telegram-desktop.log"), "log");

    expect(() => stageFullSessionArtifacts(outputDir)).toThrow(
      "Missing proof report. Run finish first: telegram-user-crabbox-proof.md",
    );
    expect(fs.existsSync(path.join(outputDir, "publish-full-artifacts"))).toBe(false);
  });

  posixIt("does not expand generated remote probe arguments in the shell", () => {
    const root = makeTempDir();
    const fakePython = path.join(root, "python3");
    const scriptPath = path.join(root, "remote-probe.sh");
    const argvPath = path.join(root, "argv.json");
    const injectedPath = path.join(root, "injected");
    const payload = `literal ' $(touch ${injectedPath})`;
    writeExecutable(
      fakePython,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.OPENCLAW_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(1)));
`,
    );
    writeExecutable(
      scriptPath,
      renderRemoteProbe({
        expect: [payload],
        sutUsername: payload,
        text: payload,
        timeoutMs: 1000,
      }),
    );

    const result = spawnSync("bash", [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_TEST_ARGV_PATH: argvPath,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(injectedPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(argvPath, "utf8"))).toContain(payload);
  });

  it("clamps oversized command timeouts before arming timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      runCommand({
        args: ["--version"],
        command: process.execPath,
        cwd: process.cwd(),
        timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      }),
    ).resolves.toMatchObject({ stderr: "" });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    setTimeoutSpy.mockRestore();
  });

  posixIt("kills timed-out command process groups when the leader exits first", async () => {
    const root = makeTempDir();
    const scriptPath = path.join(root, "trap-term.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let grandchildPid = 0;

    fs.writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand({
      args: [scriptPath, grandchildPidPath],
      command: process.execPath,
      cwd: root,
      timeoutKillGraceMs: 100,
      timeoutMs: 500,
    });
    const runResult = runPromise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );

    try {
      await waitFor(() => {
        if (!fs.existsSync(grandchildPidPath)) {
          return false;
        }
        grandchildPid = Number.parseInt(fs.readFileSync(grandchildPidPath, "utf8"), 10);
        return Number.isInteger(grandchildPid) && isProcessAlive(grandchildPid);
      });
      expect(Number.isInteger(grandchildPid)).toBe(true);

      const result = await runResult;
      expect(result).toMatchObject({
        error: {
          code: "ETIMEDOUT",
          message: expect.stringContaining("timed out after 500ms"),
        },
        ok: false,
      });
      await waitFor(() => !isProcessAlive(grandchildPid));
    } finally {
      await runResult.catch(() => {});
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });

  it("signals Windows proof command process trees with taskkill", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    signalCommandTree(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );

    signalCommandTree(child, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills Windows proof command process trees when graceful taskkill fails", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    signalCommandTree(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  posixIt("lets timed-out command descendants exit during kill grace", async () => {
    const root = makeTempDir();
    const scriptPath = path.join(root, "trap-term-grace.mjs");
    const readyPath = path.join(root, "descendant.ready");
    const donePath = path.join(root, "descendant.done");

    fs.writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

const descendant = spawn(process.execPath, [
  "--input-type=module",
  "--eval",
  ${JSON.stringify(
    `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(donePath)}, "done");
    process.exit(0);
  }, 75);
});
writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 1000);`,
  )},
], { stdio: "ignore" });
descendant.unref();
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand({
      args: [scriptPath],
      command: process.execPath,
      cwd: root,
      timeoutKillGraceMs: 500,
      timeoutMs: 500,
    });

    await waitFor(() => fs.existsSync(readyPath));
    await expect(runPromise).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: expect.stringContaining("timed out after 500ms"),
    });
    expect(fs.readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("keeps closed command groups tracked for parent cleanup", async () => {
    const root = makeTempDir();
    const commandPath = path.join(root, "closed-command.mjs");
    const runnerPath = path.join(root, "closed-command-runner.mjs");
    const commandSettledPath = path.join(root, "command-settled");
    const descendantPidPath = path.join(root, "closed-command-descendant.pid");
    const descendantTermPath = path.join(root, "closed-command-descendant.term");
    let descendantPid = 0;

    fs.writeFileSync(
      commandPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const descendant = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(
    `const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(descendantTermPath)}, "terminated");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
setInterval(() => {}, 1000);`,
  )},
], { stdio: "ignore" });
descendant.unref();
`,
      "utf8",
    );
    fs.writeFileSync(
      runnerPath,
      `
import fs from "node:fs";

const proof = await import(${JSON.stringify(
        pathToFileURL(path.resolve("scripts/e2e/telegram-user-crabbox-proof.ts")).href,
      )});
await proof.runCommand({
  args: [${JSON.stringify(commandPath)}],
  command: process.execPath,
  cwd: ${JSON.stringify(root)},
  timeoutMs: 30_000,
});
fs.writeFileSync(${JSON.stringify(commandSettledPath)}, "1");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    try {
      await waitFor(() => {
        if (!fs.existsSync(descendantPidPath)) {
          return false;
        }
        descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
        return (
          Number.isInteger(descendantPid) && descendantPid > 1 && isProcessAlive(descendantPid)
        );
      });
      expect(Number.isInteger(descendantPid)).toBe(true);
      await waitFor(() => fs.existsSync(commandSettledPath));
      if (!runner.pid) {
        throw new Error("runner did not start");
      }

      process.kill(runner.pid, "SIGTERM");

      await waitFor(() => fs.existsSync(descendantTermPath));
      await waitFor(() => !isProcessAlive(descendantPid));
    } finally {
      if (runner.pid && isProcessAlive(runner.pid)) {
        process.kill(runner.pid, "SIGKILL");
      }
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  posixIt("cleans local SUT children when gateway startup fails", async () => {
    const root = makeTempDir();
    const outputDir = makeTempDir();
    const mockScript = path.join(root, "scripts/e2e/mock-openai-server.mjs");
    const gatewayScript = path.join(root, "gateway-fail.mjs");
    const mockPidPath = path.join(root, "mock.pid");
    const mockTermPath = path.join(root, "mock.term");
    fs.mkdirSync(path.dirname(mockScript), { recursive: true });
    writeExecutable(
      mockScript,
      `
import fs from "node:fs";

// Handler before the readiness line: SIGTERM arrives once the gateway spawn
// fails, and a late-registered handler can lose it to the default disposition.
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(mockTermPath)}, "terminated");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(mockPidPath)}, String(process.pid));
process.stdout.write("mock-openai listening\\n");
setInterval(() => {}, 1000);
`,
    );
    writeExecutable(
      gatewayScript,
      `
process.stderr.write("gateway startup failed\\n");
process.exit(2);
`,
    );

    await expect(
      startLocalSut(
        {
          gatewayPort: 19042,
          groupId: "group",
          mockPort: 19043,
          mockResponseText: "ok",
          outputDir,
          repoRoot: root,
          sutToken: "token",
          testerId: "tester",
        },
        {
          createGatewaySpawnSpec: () => ({
            args: [gatewayScript],
            command: process.execPath,
            options: { cwd: root, env: process.env },
          }),
          drainUpdates: async () => ({
            drained: 0,
            pendingAfter: undefined,
            pendingBefore: undefined,
            webhookUrlSet: false,
          }),
        },
      ),
    ).rejects.toThrow("gateway exited before ready");

    await waitFor(() => fs.existsSync(mockTermPath));
    const mockPid = Number.parseInt(fs.readFileSync(mockPidPath, "utf8"), 10);
    await waitFor(() => !isProcessAlive(mockPid));
  });

  posixIt("cleans gateway descendants after a failed gateway leader exits", async () => {
    const root = makeTempDir();
    const outputDir = makeTempDir();
    const mockScript = path.join(root, "scripts/e2e/mock-openai-server.mjs");
    const gatewayScript = path.join(root, "gateway-leader-exits.mjs");
    const gatewayGrandchildPidPath = path.join(root, "gateway-grandchild.pid");
    let gatewayGrandchildPid = 0;
    fs.mkdirSync(path.dirname(mockScript), { recursive: true });
    writeExecutable(
      mockScript,
      `
process.stdout.write("mock-openai listening\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    writeExecutable(
      gatewayScript,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(gatewayGrandchildPidPath)}, String(grandchild.pid));
process.exit(2);
`,
    );

    try {
      await expect(
        startLocalSut(
          {
            gatewayPort: 19042,
            groupId: "group",
            mockPort: 19043,
            mockResponseText: "ok",
            outputDir,
            repoRoot: root,
            sutToken: "token",
            testerId: "tester",
          },
          {
            createGatewaySpawnSpec: () => ({
              args: [gatewayScript],
              command: process.execPath,
              options: { cwd: root, env: process.env },
            }),
            drainUpdates: async () => ({
              drained: 0,
              pendingAfter: undefined,
              pendingBefore: undefined,
              webhookUrlSet: false,
            }),
            waitForOutputReady: async (child, _pattern, output, label) => {
              if (label === "mock-openai") {
                await waitFor(() => output().includes("mock-openai listening"));
                return;
              }
              // Parse inside the poll: existsSync can observe writeFileSync's
              // 0-byte open-truncate window, and a NaN pid would skip both the
              // dead-check and the finally-block SIGKILL cleanup.
              await waitFor(() => {
                if (!fs.existsSync(gatewayGrandchildPidPath)) {
                  return false;
                }
                gatewayGrandchildPid = Number.parseInt(
                  fs.readFileSync(gatewayGrandchildPidPath, "utf8"),
                  10,
                );
                return Number.isInteger(gatewayGrandchildPid) && gatewayGrandchildPid > 1;
              });
              if (child.exitCode === null && child.signalCode === null) {
                await new Promise<void>((resolve) => {
                  child.once("exit", () => resolve());
                });
              }
              throw new Error("gateway exited before ready");
            },
          },
        ),
      ).rejects.toThrow("gateway exited before ready");

      await waitFor(() => !isProcessAlive(gatewayGrandchildPid));
    } finally {
      if (gatewayGrandchildPid && isProcessAlive(gatewayGrandchildPid)) {
        process.kill(gatewayGrandchildPid, "SIGKILL");
      }
    }
  });

  posixIt("stops Crabbox recording when the desktop probe fails", async () => {
    const root = makeTempDir();
    const recorderPath = path.join(root, "fake-crabbox-recorder.mjs");
    const recorderPidPath = path.join(root, "recorder.pid");
    const recorderTermPath = path.join(root, "recorder.term");
    writeExecutable(
      recorderPath,
      `#!/usr/bin/env node
import fs from "node:fs";

// Arm the SIGTERM handler before publishing the pid file: the probe throws as
// soon as the pid file exists and recordProbeVideo SIGTERMs the recorder in
// its finally, so a handler installed after publish can lose that signal to
// the default disposition and recorder.term is never written.
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(recorderTermPath)}, "terminated");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(recorderPidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    );

    await expect(
      recordProbeVideo({
        crabboxBin: recorderPath,
        cwd: root,
        durationSeconds: 30,
        leaseId: "cbx_test",
        outputPath: path.join(root, "proof.mp4"),
        provider: "aws",
        runProbe: async () => {
          await waitFor(() => fs.existsSync(recorderPidPath));
          throw new Error("probe failed");
        },
        startDelayMs: 0,
        target: "linux",
      }),
    ).rejects.toThrow("probe failed");

    await waitFor(() => fs.existsSync(recorderTermPath));
    const recorderPid = Number.parseInt(fs.readFileSync(recorderPidPath, "utf8"), 10);
    await waitFor(() => !isProcessAlive(recorderPid));
  });

  posixIt(
    "does not wait forever when Crabbox recording exits before the probe returns",
    async () => {
      const root = makeTempDir();
      const recorderPath = path.join(root, "fake-crabbox-recorder.mjs");
      const recorderExitPath = path.join(root, "recorder.exit");
      writeExecutable(
        recorderPath,
        `#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(${JSON.stringify(recorderExitPath)}, "exited");
`,
      );

      await expect(
        Promise.race([
          recordProbeVideo({
            crabboxBin: recorderPath,
            cwd: root,
            durationSeconds: 1,
            leaseId: "cbx_test",
            outputPath: path.join(root, "proof.mp4"),
            provider: "aws",
            runProbe: async () => {
              await waitFor(() => fs.existsSync(recorderExitPath));
              await delay(50);
            },
            startDelayMs: 0,
            target: "linux",
          }),
          delay(500, undefined, { ref: false }).then(() => {
            throw new Error("recordProbeVideo hung after the recorder had already exited");
          }),
        ]),
      ).resolves.toBeUndefined();
    },
  );
});
