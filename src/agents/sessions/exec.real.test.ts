import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import type { TextContent } from "../../llm/types.js";
import { execCommand } from "./exec.js";
import { createBashTool, createLocalBashOperations } from "./tools/bash.js";

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

describe("Windows bash session output", () => {
  it.runIf(process.platform === "win32")(
    "proves readable CP936 output and decoded truncated spill through the local tool",
    async () => {
      const cp936Bytes =
        "\\xC7\\xFD\\xB6\\xAF\\xC6\\xF7 C \\xD6\\xD0\\xB5\\xC4\\xBE\\xED\\xCA\\xC7 Acer";
      const expected = "\u9a71\u52a8\u5668 C \u4e2d\u7684\u5377\u662f Acer";
      const tool = createBashTool(process.cwd(), {
        operations: {
          ...createLocalBashOperations(),
          createTextDecoder: () =>
            createWindowsOutputDecoder({ platform: "win32", windowsEncoding: "gbk" }),
        },
      });
      const decodedResult = await tool.execute("windows-cp936", {
        command: `printf '${cp936Bytes}\\n'`,
      });
      const decoded =
        decodedResult.content.find((item): item is TextContent => item.type === "text")?.text ?? "";
      expect(decoded).toBe(`${expected}\n`);

      const spillResult = await tool.execute("windows-cp936-spill", {
        command: `for i in $(seq 1 9000); do printf '${cp936Bytes}\\n'; done`,
      });
      const fullOutputPath = (spillResult.details as { fullOutputPath?: string } | undefined)
        ?.fullOutputPath;
      expect(fullOutputPath).toBeDefined();
      const fullOutput = await readFile(fullOutputPath!, "utf8");
      expect(fullOutput.startsWith(`${expected}\n`)).toBe(true);
      expect(fullOutput.includes("\ufffd")).toBe(false);

      const utf8Result = await tool.execute("windows-utf8-control", {
        command: "printf 'UTF8_OK_hello\\n'",
      });
      const utf8Output =
        utf8Result.content.find((item): item is TextContent => item.type === "text")?.text ?? "";
      expect(utf8Output).toBe("UTF8_OK_hello\n");
      console.log(`WINDOWS_BASH_PROOF decoded=${decoded.trim()}`);
      const spillDecoded = fullOutput.startsWith(`${expected}\n`);
      const replacementCharacter = fullOutput.includes("\ufffd");
      console.log(
        `WINDOWS_BASH_PROOF spillDecoded=${spillDecoded} replacementCharacter=${replacementCharacter}`,
      );
      console.log(`WINDOWS_BASH_PROOF utf8=${utf8Output.trim()}`);
      await rm(fullOutputPath!, { force: true });
    },
  );
});
