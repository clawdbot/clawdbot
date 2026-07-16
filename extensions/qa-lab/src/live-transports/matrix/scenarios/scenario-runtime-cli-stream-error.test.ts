// QA Lab Matrix tests cover parent-side CLI pipe failures.
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  children: [] as ChildProcess[],
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMocks.spawn.mockImplementation((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    childProcessMocks.children.push(child);
    return child;
  });
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

import { startMatrixQaOpenClawCli } from "./scenario-runtime-cli.js";

async function createCliRoot(): Promise<{
  grandchildPidPath: string;
  grandchildReadyPath: string;
  root: string;
}> {
  const root = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-stream-error-"),
  );
  const grandchildPidPath = path.join(root, "grandchild.pid");
  const grandchildReadyPath = path.join(root, "grandchild.ready");
  const grandchildScript = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `writeFileSync(${JSON.stringify(grandchildReadyPath)}, 'ready');`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  await mkdir(path.join(root, "dist"));
  await writeFile(
    path.join(root, "dist", "index.mjs"),
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
      "process.stdout.write('ready\\n');",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return { grandchildPidPath, grandchildReadyPath, root };
}

function latestChild(): ChildProcess {
  const child = childProcessMocks.children.at(-1);
  expect(child).toBeDefined();
  return child as ChildProcess;
}

async function waitForChildClose(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(pathToCheck: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(pathToCheck, "utf8")).trim();
      const pid = Number(value);
      if (/^[1-9]\d*$/u.test(value) && Number.isSafeInteger(pid)) {
        return pid;
      }
    } catch {}
    await sleep(5);
  }
  throw new Error(`Timed out waiting for a PID in ${pathToCheck}`);
}

async function waitForFile(pathToCheck: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(pathToCheck);
      return;
    } catch {}
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${pathToCheck}`);
}

describe("Matrix QA CLI runtime stream errors", () => {
  beforeEach(() => {
    childProcessMocks.children.length = 0;
    childProcessMocks.spawn.mockClear();
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects after cleaning up when %s emits a stream error",
    async (streamName) => {
      const { grandchildPidPath, grandchildReadyPath, root } = await createCliRoot();
      let child: ChildProcess | undefined;
      let grandchildPid: number | undefined;
      let session: ReturnType<typeof startMatrixQaOpenClawCli> | undefined;
      let childClosed = false;
      try {
        session = startMatrixQaOpenClawCli({
          args: ["matrix", "verify", "self"],
          cwd: root,
          env: process.env,
          timeoutMs: 5_000,
        });
        child = latestChild();
        child.once("close", () => {
          childClosed = true;
        });
        await session.waitForOutput(
          (output) => output.stdout.includes("ready"),
          "ready marker",
          2_000,
        );
        grandchildPid = await waitForPidFile(grandchildPidPath, 2_000);
        await waitForFile(grandchildReadyPath, 2_000);

        child[streamName]?.emit("error", new Error(`${streamName} pipe failed`));

        await expect(session.wait()).rejects.toThrow(
          `${streamName} stream error: ${streamName} pipe failed`,
        );
        expect(childClosed).toBe(true);
        expect(isProcessRunning(grandchildPid)).toBe(false);
      } finally {
        session?.kill();
        await waitForChildClose(child);
        if (grandchildPid && isProcessRunning(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        await rm(root, { force: true, recursive: true });
      }
    },
  );
});
