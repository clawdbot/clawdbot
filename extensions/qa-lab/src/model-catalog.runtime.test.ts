// Qa Lab tests cover model catalog plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadQaRunnerModelOptions } from "./model-catalog.runtime.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(cleanup);

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolvePoll) => {
        setTimeout(resolvePoll, 25);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, 25);
    });
  }
  throw new Error(`timed out waiting for pid ${pid} to exit`);
}

describe("qa runner model catalog", () => {
  it("filters catalog output and prefers gpt-5.6-luna first", async () => {
    const repoRoot = await makeTempDir("openclaw-qa-model-catalog-output-");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "index.js"),
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          models: [
            null,
            {
              key: "anthropic/claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              input: "text",
              available: true,
              missing: false,
            },
            {
              key: "openai/gpt-5.6-luna",
              name: "gpt-5.6-luna",
              input: "text,image",
              available: true,
              missing: false,
            },
            {
              key: "openrouter/auto",
              name: "OpenRouter Auto",
              input: "text",
              available: false,
              missing: false,
            },
          ],
        }),
      )});\n`,
      "utf8",
    );

    await expect(loadQaRunnerModelOptions({ repoRoot })).resolves.toEqual([
      expect.objectContaining({ key: "openai/gpt-5.6-luna" }),
      expect.objectContaining({ key: "anthropic/claude-sonnet-4-6" }),
    ]);
  });

  it("reports malformed catalog JSON with an owned error", async () => {
    const repoRoot = await makeTempDir("openclaw-qa-model-catalog-malformed-");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "index.js"),
      `process.stdout.write("{not json");\n`,
      "utf8",
    );

    await expect(loadQaRunnerModelOptions({ repoRoot })).rejects.toThrow(
      "qa model catalog returned malformed JSON",
    );
  });

  it.runIf(process.platform !== "win32")(
    "kills aborted catalog process groups when the catalog child exits first",
    async () => {
      const repoRoot = await makeTempDir("openclaw-qa-model-catalog-");
      const pidPath = path.join(repoRoot, "descendant.pid");
      let descendantPid: number | undefined;
      const controller = new AbortController();
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const catalogScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      try {
        await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
        await fs.writeFile(path.join(repoRoot, "dist", "index.js"), catalogScript, "utf8");
        const runPromise = loadQaRunnerModelOptions({
          repoRoot,
          signal: controller.signal,
          abortKillGraceMs: 100,
        });

        await waitForFile(pidPath, 2_000);
        descendantPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        controller.abort();

        await expect(runPromise).rejects.toThrow("qa model catalog aborted");
        await waitForDead(descendantPid, 2_000);
      } finally {
        if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves abort grace when catalog descendants exit cleanly",
    async () => {
      const repoRoot = await makeTempDir("openclaw-qa-model-catalog-clean-");
      const readyPath = path.join(repoRoot, "descendant.ready");
      const cleanupPath = path.join(repoRoot, "descendant.cleanup");
      const pidPath = path.join(repoRoot, "descendant.pid");
      let descendantPid: number | undefined;
      const controller = new AbortController();
      const childScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, 'clean');`,
        "    process.exit(0);",
        "  }, 75);",
        "});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const catalogScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      try {
        await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
        await fs.writeFile(path.join(repoRoot, "dist", "index.js"), catalogScript, "utf8");
        const runPromise = loadQaRunnerModelOptions({
          repoRoot,
          signal: controller.signal,
        });

        await waitForFile(readyPath, 2_000);
        descendantPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
        expect(Number.isInteger(descendantPid)).toBe(true);
        const abortStartedAt = Date.now();
        controller.abort();

        await expect(runPromise).rejects.toThrow("qa model catalog aborted");
        expect(await fs.readFile(cleanupPath, "utf8")).toBe("clean");
        expect(Date.now() - abortStartedAt).toBeLessThan(1_700);
        await waitForDead(descendantPid, 2_000);
      } finally {
        if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );
});
