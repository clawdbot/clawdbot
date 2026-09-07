import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as execSpawn from "../process/exec-spawn.js";
import * as processExecution from "../process/exec.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { readPidFile, waitForPidToExit } from "../test-utils/process-tree.js";
import { withTempDir } from "../test-utils/temp-dir.js";
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
    expect(result.errorClassification).toBeUndefined();
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
    expect(result.errorClassification).toEqual({ kind: "permanent" });
    expect(result.failureNotificationDetail).toEqual({ kind: "command-exit", exitCode: 7 });
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
    expect(result.errorClassification).toEqual({ kind: "reason", reason: "timeout" });
    expect(result.failureNotificationDetail).toEqual({
      kind: "command-timeout",
      mode: "wall-clock",
    });
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 456,
      source: "exec",
      severity: "error",
    });
  });

  it.skipIf(process.platform === "win32")("kills shell process groups on timeout", async () =>
    withTempDir("openclaw-cron-command-", async (tempDir) => {
      const childPidPath = path.join(tempDir, "child.pid");
      const shellCommand = [
        "sleep 60 &",
        "child_pid=$!",
        `printf '%s' "$child_pid" > ${JSON.stringify(childPidPath)}`,
        'wait "$child_pid"',
      ].join("\n");

      const controller = new AbortController();
      const realSetTimeout = setTimeout;
      const spawnSpy = vi.spyOn(execSpawn, "spawnCommandWithInvocation");
      let parent: ChildProcess | undefined;
      let command: ReturnType<typeof runCronCommandJob> | undefined;
      try {
        // Freeze the deadline until the real shell has published a live child;
        // startup time must not consume the behavior this test is exercising.
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        command = runCronCommandJob({
          job: makeCommandJob({
            kind: "command",
            argv: ["sh", "-lc", shellCommand],
            timeoutSeconds: 0.5,
          }),
          abortSignal: controller.signal,
        });
        const spawnResult = spawnSpy.mock.results[0];
        if (spawnResult?.type !== "return") {
          throw new Error("command did not spawn");
        }
        parent = spawnResult.value.child.nodeChildProcess;
        let childPid = 0;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (existsSync(childPidPath)) {
            childPid = await readPidFile(childPidPath);
            if (Number.isSafeInteger(childPid) && isPidAlive(childPid)) {
              break;
            }
          }
          await new Promise<void>((resolve) => {
            realSetTimeout(resolve, 25);
          });
        }
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(isPidAlive(childPid)).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);
        // Force delivery now has a separate bounded exit-observation phase.
        await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);
        const result = await command;
        expect(result.status).toBe("error");
        expect(result.error).toBe("command timed out");
        vi.useRealTimers();
        expect(await waitForPidToExit(childPid)).toBe(true);
      } finally {
        try {
          controller.abort();
          if (parent?.pid) {
            try {
              process.kill(-parent.pid, "SIGKILL");
            } catch {
              // The command may already have reaped its process group.
            }
          }
          if (vi.isFakeTimers()) {
            await vi.runAllTimersAsync();
          }
        } finally {
          vi.useRealTimers();
          spawnSpy.mockRestore();
          await command;
        }
      }
    }),
  );

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
    expect(result.errorClassification).toEqual({ kind: "reason", reason: "timeout" });
    expect(result.failureNotificationDetail).toEqual({
      kind: "command-timeout",
      mode: "no-output",
    });
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
    expect(result.errorClassification).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.failureNotificationDetail).toBeUndefined();
  });

  it("keeps command start failures generic", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: ["openclaw-command-that-does-not-exist"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.failureNotificationDetail).toBeUndefined();
    expect(result.errorClassification).toEqual({ kind: "permanent" });
  });

  it("leaves transient command start errors unclassified", async () => {
    const spawnError = Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    const runCommand = vi
      .spyOn(processExecution, "runCommandWithTimeout")
      .mockRejectedValueOnce(spawnError);

    try {
      const result = await runCronCommandJob({
        job: makeCommandJob({ kind: "command", argv: [process.execPath] }),
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe("spawn EAGAIN");
      expect(result.errorClassification).toBeUndefined();
    } finally {
      runCommand.mockRestore();
    }
  });
});
