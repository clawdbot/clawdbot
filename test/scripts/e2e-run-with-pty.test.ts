import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/e2e/lib/run-with-pty.mjs");
const posixIt = process.platform === "win32" ? it.skip : it;

function runPtyProbe(
  logPath: string,
  env: Record<string, string> = {},
  command: string[] = [
    "/bin/bash",
    "-lc",
    'printf "prompt\\n"; IFS= read -r value; printf "got:%s\\n" "$value"',
  ],
  input = "abc\n",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, logPath, ...command], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("PTY probe timed out"));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe("run-with-pty", () => {
  it("rejects loose terminal dimension env values", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
    const logPath = path.join(tempRoot, "pty.log");
    try {
      const result = await runPtyProbe(logPath, { COLUMNS: "120cols" });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("invalid COLUMNS: 120cols");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forwards stdin through a PTY and writes the transcript log", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
    const logPath = path.join(tempRoot, "pty.log");
    try {
      const result = await runPtyProbe(logPath);
      const log = await readFile(logPath, "utf8");

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("prompt");
      expect(result.stdout).toContain("got:abc");
      expect(log).toContain("prompt");
      expect(log).toContain("got:abc");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("caps noisy PTY output in stdout and transcript logs", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
    const logPath = path.join(tempRoot, "pty.log");
    try {
      const result = await runPtyProbe(
        logPath,
        { OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES: "64" },
        [process.execPath, "-e", "process.stdout.write('x'.repeat(2048))"],
        "",
      );
      const log = await readFile(logPath, "utf8");
      const marker = "[run-with-pty output truncated after 64 bytes]";

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain(marker);
      expect(log).toContain(marker);
      expect(result.stdout.length).toBeLessThan(512);
      expect(log.length).toBeLessThan(512);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails when the transcript log cannot be written", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
    try {
      const result = await runPtyProbe(
        tempRoot,
        {},
        [process.execPath, "-e", "console.log('ready')"],
        "",
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("run-with-pty transcript log failed:");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  posixIt("escalates forwarded termination signals for PTY commands that ignore them", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
    const logPath = path.join(tempRoot, "pty.log");
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        logPath,
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_E2E_PTY_FORCE_KILL_MS: "25",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => stdout.includes("ready"));
      child.kill("SIGTERM");
      const result = await waitForClose(child, 5_000);
      const log = await readFile(logPath, "utf8");

      expect(result).toEqual({ code: 143, signal: null });
      expect(stderr).toBe("");
      expect(log).toContain("ready");
    } finally {
      if (child.pid && isProcessAlive(child.pid)) {
        child.kill("SIGKILL");
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for PTY wrapper close"));
      }, timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
