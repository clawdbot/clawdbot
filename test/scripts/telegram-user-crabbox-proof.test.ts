import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_TIMEOUT_MS,
  createOpenClawGatewaySpawnSpec,
  readLogTail,
  readTelegramUserProofLogTailBytes,
  REMOTE_SETUP_COMMAND_TIMEOUT_MS,
  runCommand,
  waitForLog,
} from "../../scripts/e2e/telegram-user-crabbox-proof.ts";

const tempDirs: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(25);
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
      timeoutKillGraceMs: 25,
      timeoutMs: 100,
    });

    try {
      await waitFor(() => fs.existsSync(grandchildPidPath));
      grandchildPid = Number.parseInt(fs.readFileSync(grandchildPidPath, "utf8"), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await expect(runPromise).rejects.toMatchObject({
        code: "ETIMEDOUT",
        message: expect.stringContaining("timed out after 100ms"),
      });
      await waitFor(() => !isProcessAlive(grandchildPid));
    } finally {
      await runPromise.catch(() => {});
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });
});
