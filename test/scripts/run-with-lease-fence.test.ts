import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitForChildClose, waitForFile, waitForPidFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/mantis/run-with-lease-fence.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The Telegram Desktop workflow owns this Linux fence: util-linux setsid,
// Linux account setup, and /proc cleanup are not an arbitrary POSIX contract.
describe.runIf(process.platform === "linux")("run-with-lease-fence", () => {
  beforeAll(() => {
    const result = spawnSync("setsid", ["--version"], { encoding: "utf8" });
    expect(
      result.status,
      "Linux lease-fence tests require util-linux setsid on PATH; install bash, util-linux, and coreutils.",
    ).toBe(0);
  });

  it("stops the active process group after terminal lease loss", async () => {
    const root = tempDirs.make("openclaw-lease-fence-");
    const lostMarker = path.join(root, "lease.lost");
    const commandPidFile = path.join(root, "command.pid");
    const ticksFile = path.join(root, "ticks.log");
    let stderr = "";
    const child = spawn(
      SCRIPT,
      [
        lostMarker,
        "--",
        "/bin/bash",
        "-c",
        'trap "exit 0" TERM; printf "%s\\n" "$$" >"$1"; while :; do printf "tick\\n" >>"$2"; sleep 1; done',
        "lease-fence-command",
        commandPidFile,
        ticksFile,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Readiness can fail after the command starts. Keep it under cleanup, and
    // handle a child that already exited before a close waiter is attached.
    const waitForFenceClose = () =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
        : waitForChildClose(child);
    let cleanupPid: number | undefined;
    try {
      const commandPid = await waitForPidFile(commandPidFile, 2_000);
      cleanupPid = commandPid;
      await waitForFile(ticksFile, 2_000);
      const closed = waitForFenceClose();
      fs.writeFileSync(lostMarker, "lost\n");
      await expect(closed).resolves.toEqual({
        code: 97,
        signal: null,
      });
      expect(() => process.kill(-commandPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      expect(stderr).toContain("::error::Telegram QA lease lost mid-run; fencing proof");
    } finally {
      // Let the fence reap its group even if readiness failed before we read
      // the PID; recover a late PID for forced cleanup if fencing also fails.
      const closed = waitForFenceClose();
      fs.writeFileSync(lostMarker, "lost\n");
      try {
        await closed;
      } finally {
        const forcedClose =
          child.exitCode === null && child.signalCode === null
            ? waitForChildClose(child)
            : undefined;
        if (forcedClose) {
          child.kill("SIGKILL");
        }
        if (cleanupPid === undefined && fs.existsSync(commandPidFile)) {
          cleanupPid = Number.parseInt(fs.readFileSync(commandPidFile, "utf8"), 10);
        }
        if (cleanupPid !== undefined && Number.isInteger(cleanupPid) && cleanupPid > 0) {
          try {
            process.kill(-cleanupPid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
        await forcedClose;
      }
    }
  }, 20_000);

  it("propagates a clean command exit", () => {
    const root = tempDirs.make("openclaw-lease-fence-clean-");
    const result = spawnSync(SCRIPT, [path.join(root, "lease.lost"), "--", "/bin/true"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("passes the caller's stdin through to the fenced command", () => {
    // The workflow pipes the agent prompt into the fenced Codex process; a
    // backgrounded child otherwise defaults its stdin to /dev/null, which
    // made the agent fail with an empty prompt.
    const root = tempDirs.make("openclaw-lease-fence-stdin-");
    const result = spawnSync(SCRIPT, [path.join(root, "lease.lost"), "--", "/bin/cat"], {
      encoding: "utf8",
      input: "prompt body\n",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("prompt body\n");
  });
});
