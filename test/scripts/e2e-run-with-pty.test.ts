import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/e2e/lib/run-with-pty.mjs");

function runPtyProbe(logPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        logPath,
        "/bin/bash",
        "-lc",
        'printf "prompt\\n"; IFS= read -r value; printf "got:%s\\n" "$value"',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
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
    child.stdin.end("abc\n");
  });
}

describe("run-with-pty", () => {
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
});
