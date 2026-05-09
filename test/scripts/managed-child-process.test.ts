import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { signalExitCode } from "../../scripts/lib/managed-child-process.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function expectProcessPid(pid: number | undefined): number {
  if (pid == null) {
    throw new Error("Expected spawned process to expose a pid");
  }
  return pid;
}

describe("managed-child-process", () => {
  it("maps forwarded signals to shell-compatible exit codes", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  it("kills the managed child process group when the runner is terminated", async () => {
    const dir = createTempDir("openclaw-managed-child-");
    const childPath = path.join(dir, "child.mjs");
    const runnerPath = path.join(dir, "runner.mjs");
    const childPidPath = path.join(dir, "child.pid");
    const runnerReadyPath = path.join(dir, "runner.ready");
    const helperUrl = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mjs")).href;

    fs.writeFileSync(
      childPath,
      `
import fs from "node:fs";

fs.writeFileSync(process.argv[2], String(process.pid));
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}
setInterval(() => {}, 1_000);
`,
      "utf8",
    );
    fs.writeFileSync(
      runnerPath,
      `
import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(helperUrl)};

process.exitCode = await runManagedCommand({
  bin: process.execPath,
  args: [${JSON.stringify(childPath)}, ${JSON.stringify(childPidPath)}],
  stdio: "ignore",
  onReady: () => fs.writeFileSync(${JSON.stringify(runnerReadyPath)}, "1"),
});
`,
      "utf8",
    );

    const runner = spawn(process.execPath, [runnerPath], {
      stdio: "ignore",
    });
    const runnerPid = expectProcessPid(runner.pid);
    let childPid = 0;

    try {
      await waitFor(() => fs.existsSync(runnerReadyPath));
      await waitFor(() => fs.existsSync(childPidPath));
      childPid = Number(fs.readFileSync(childPidPath, "utf8"));
      expect(Number.isInteger(childPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      process.kill(runnerPid, "SIGTERM");
      const result = await waitForClose(runner);

      expect(result).toEqual({ code: 143, signal: null });
      await waitFor(() => !isProcessAlive(childPid), 10_000);
    } finally {
      if (isProcessAlive(runnerPid)) {
        process.kill(runnerPid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(25);
  }
}

async function waitForClose(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
