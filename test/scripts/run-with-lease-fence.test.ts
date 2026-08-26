import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForChildClose, waitForFile, waitForPidFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/mantis/run-with-lease-fence.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const posixIt = process.platform === "win32" ? it.skip : it;

describe("run-with-lease-fence", () => {
  posixIt(
    "stops the active process group after terminal lease loss",
    async () => {
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

      const commandPid = await waitForPidFile(commandPidFile, 2_000);
      await waitForFile(ticksFile, 2_000);
      fs.writeFileSync(lostMarker, "lost\n");

      try {
        await expect(waitForChildClose(child)).resolves.toEqual({
          code: 97,
          signal: null,
        });
        expect(() => process.kill(-commandPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
        expect(stderr).toContain("::error::Telegram QA lease lost mid-run; fencing proof");
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        try {
          process.kill(-commandPid, "SIGKILL");
        } catch {}
      }
    },
    20_000,
  );

  posixIt("propagates a clean command exit", () => {
    const root = tempDirs.make("openclaw-lease-fence-clean-");
    const result = spawnSync(SCRIPT, [path.join(root, "lease.lost"), "--", "/bin/true"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  posixIt("passes the caller's stdin through to the fenced command", () => {
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
