import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCronCommandJob } from "./command-runner.js";
import type { CronJob } from "./types.js";

function makeCommandJob(payload: Extract<CronJob["payload"], { kind: "command" }>): CronJob {
  const now = Date.now();
  return {
    id: "command-job",
    name: "Command job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

function isProcessRunning(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  const state = result.stdout.trim();
  if (result.status === 0) {
    return !state.startsWith("Z");
  }
  if (result.status === 1 && state === "" && result.stderr.trim() === "") {
    return false;
  }
  throw new Error(
    `ps failed with status ${result.status ?? "unknown"}: ${result.stderr.trim() || "no output"}`,
  );
}

describe("runCronCommandJob", () => {
  it("runs command argv and returns stdout as the deliverable summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('hello from cron')"],
        timeoutSeconds: 5,
      }),
      nowMs: () => 123,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello from cron");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 123,
      source: "exec",
      severity: "info",
      exitCode: 0,
    });
  });

  it("preserves exact NO_REPLY stdout for outbound suppression", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('NO_REPLY\\n')"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("NO_REPLY");
  });

  it("marks non-zero exit codes as cron errors and keeps stderr as summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stderr.write('bad thing'); process.exit(7)"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command exited with code 7");
    expect(result.summary).toBe("bad thing");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
      exitCode: 7,
    });
  });

  it("preserves early action-required command output when the captured tail is truncated", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [
          process.execPath,
          "-e",
          [
            "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
            "process.stdout.write('x'.repeat(200))",
          ].join(";"),
        ],
        timeoutSeconds: 5,
        outputMaxBytes: 24,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(
      `action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\n${"x".repeat(24)}`,
    );
    expect(result.diagnostics?.summary).toBe(result.summary);
    expect(result.diagnostics?.entries[0]).toMatchObject({ truncated: true });
  });

  it("marks command timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 0.05,
      }),
      nowMs: () => 456,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 456,
      source: "exec",
      severity: "error",
    });
  });

  it.skipIf(process.platform === "win32")("kills shell process groups on timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-command-"));
    const childPidPath = path.join(tempDir, "child.pid");
    const childScript = "setInterval(() => {}, 1000)";
    const shellCommand = [
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} &`,
      "child_pid=$!",
      `printf '%s' "$child_pid" > ${JSON.stringify(childPidPath)}`,
      'wait "$child_pid"',
    ].join("\n");

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: ["sh", "-lc", shellCommand],
        timeoutSeconds: 0.2,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");

    const childPid = Number.parseInt(await fs.readFile(childPidPath, "utf8"), 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await expect.poll(() => isProcessRunning(childPid)).toBe(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("marks no-output timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 5,
        noOutputTimeoutSeconds: 0.05,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command produced no output before noOutputTimeoutSeconds");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
    });
  });

  it("marks aborted command runs as cron errors", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('should not run')"],
        timeoutSeconds: 5,
      }),
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command stopped");
    expect(result.summary).toBeUndefined();
  });
});
