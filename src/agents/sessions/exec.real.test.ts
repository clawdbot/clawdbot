import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execCommand } from "./exec.js";

const cleanupPids = new Set<number>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness check and cleanup.
  }
}

describe("execCommand process-tree cleanup", () => {
  afterEach(() => {
    for (const pid of cleanupPids) {
      forceKillPid(pid);
    }
    cleanupPids.clear();
  });

  it("does not resolve a timeout while a SIGTERM-resistant descendant is alive", async () => {
    const readyPath = join(tempDirs.make("openclaw-exec-tree-"), "ready.json");
    const descendantScript = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true });`,
      `child.once("spawn", () => fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid })));`,
      "child.once('error', () => process.exit(1));",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const resultPromise = execCommand(process.execPath, ["-e", parentScript], process.cwd(), {
      timeout: 1_000,
    });
    const { parentPid, childPid } = await vi.waitFor(
      () =>
        JSON.parse(readFileSync(readyPath, "utf8")) as {
          parentPid: number;
          childPid: number;
        },
      { timeout: 3_000, interval: 25 },
    );
    cleanupPids.add(parentPid);
    cleanupPids.add(childPid);

    await expect(resultPromise).resolves.toMatchObject({ killed: true });
    await vi.waitFor(
      () => {
        expect(isProcessAlive(parentPid)).toBe(false);
        expect(isProcessAlive(childPid)).toBe(false);
      },
      { timeout: 500, interval: 25 },
    );
  }, 12_000);
});
