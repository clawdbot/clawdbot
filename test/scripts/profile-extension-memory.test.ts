// Profile Extension Memory tests cover profile extension memory script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs, runCase } from "../../scripts/profile-extension-memory.mjs";

const SCRIPT_PATH = path.resolve("scripts/profile-extension-memory.mjs");

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("timed out waiting for condition");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runProfileExtensionMemory(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function extractReportPath(stdout: string) {
  const match = stdout.match(/^\[extension-memory\] report: (.+)$/mu);
  const reportPath = match?.[1];
  if (!reportPath) {
    throw new Error(`missing report path in stdout:\n${stdout}`);
  }
  return reportPath;
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 8_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (status, signal) => resolve({ status, signal }));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for child exit")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("scripts/profile-extension-memory", () => {
  it("prints help without requiring built plugin artifacts", () => {
    const result = runProfileExtensionMemory(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/profile-extension-memory.mjs");
  });

  it("stops parsing options after the argument terminator", () => {
    expect(parseArgs(["--extension", "discord", "--", "--extension", "telegram"])).toMatchObject({
      extensions: ["discord"],
    });
  });

  it("accepts package-manager argument separators before script options", () => {
    expect(parseArgs(["--", "--extension", "discord", "--skip-combined"])).toMatchObject({
      extensions: ["discord"],
      skipCombined: true,
    });
  });

  it("rejects loose numeric flags before scanning built plugin artifacts", () => {
    const cases = [
      ["--concurrency", "2abc"],
      ["--timeout-ms", "1e3"],
      ["--combined-timeout-ms", "90000ms"],
      ["--top", "0x10"],
    ];

    for (const [flag, value] of cases) {
      const result = runProfileExtensionMemory([flag, value]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`[extension-memory] ${flag} must be a positive integer`);
      expect(result.stderr).not.toContain("dist/extensions");
      expect(result.stderr).not.toContain("at ");
    }
  });

  it("rejects option-looking string flag values before scanning built plugin artifacts", () => {
    for (const args of [
      ["--extension", "-h"],
      ["--json", "-h"],
    ]) {
      const result = runProfileExtensionMemory(args);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`[extension-memory] ${args[0]} requires a value`);
      expect(result.stderr).not.toContain("dist/extensions");
      expect(result.stderr).not.toContain("at ");
    }
  });

  it("bounds noisy child output without losing RSS samples", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "noisy");
      const reportPath = path.join(root, "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "index.js"),
        [
          `const fs = require("node:fs");`,
          `fs.writeSync(2, "old stderr " + "x".repeat(160000) + "\\n");`,
          `fs.writeSync(1, "old stdout " + "y".repeat(160000) + "\\n");`,
          `process.on("exit", () => fs.writeSync(2, "exit tail\\n"));`,
        ].join("\n"),
        "utf8",
      );

      const result = runProfileExtensionMemory(
        ["--extension", "noisy", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.results).toHaveLength(1);
      expect(report.results[0].status).toBe("ok");
      expect(report.results[0].maxRssMb).toEqual(expect.any(Number));
      expect(report.results[0].stderrPreview).toContain("[output truncated");
      expect(report.results[0].stderrPreview).toContain("[stderr preview truncated");
      expect(report.results[0].stderrPreview).toContain("exit tail");
      expect(report.results[0].stderrPreview).not.toContain("old stderr");
      expect(report.results[0].stderrPreview.length).toBeLessThan(9_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates parent directories for nested JSON report paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "simple");
      const reportPath = path.join(root, ".artifacts", "memory", "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(path.join(extensionDir, "index.js"), `export default {};\n`, "utf8");

      const result = runProfileExtensionMemory(
        ["--extension", "simple", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.counts).toMatchObject({ totalEntries: 1, ok: 1, fail: 0, timeout: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses distinct default JSON report paths for separate runs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    const reportPaths: string[] = [];
    try {
      const extensionDir = path.join(root, "dist", "extensions", "simple");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(path.join(extensionDir, "index.js"), `export default {};\n`, "utf8");

      for (let index = 0; index < 2; index += 1) {
        const result = runProfileExtensionMemory(
          ["--extension", "simple", "--skip-combined", "--concurrency", "1"],
          root,
        );

        expect(result.status, result.stderr).toBe(0);
        const reportPath = extractReportPath(result.stdout);
        reportPaths.push(reportPath);
        expect(path.dirname(reportPath)).toBe(tmpdir());
        expect(path.basename(reportPath)).toMatch(
          /^openclaw-extension-memory-\d+-\d+-[0-9a-f-]+\.json$/u,
        );
        expect(JSON.parse(readFileSync(reportPath, "utf8")).counts).toMatchObject({
          totalEntries: 1,
          ok: 1,
          fail: 0,
          timeout: 0,
        });
      }

      expect(reportPaths[0]).not.toBe(reportPaths[1]);
    } finally {
      for (const reportPath of reportPaths) {
        rmSync(reportPath, { force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a profiled plugin import fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "broken");
      const reportPath = path.join(root, "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "index.js"),
        `throw new Error("broken plugin import");\n`,
        "utf8",
      );

      const result = runProfileExtensionMemory(
        ["--extension", "broken", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[extension-memory] broken import fail");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.counts).toMatchObject({ fail: 1, ok: 0, timeout: 0 });
      expect(report.results[0]).toMatchObject({ dir: "broken", status: "fail" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves spawn errors without waiting for the timeout", async () => {
    const startedAt = Date.now();
    const result = await runCase({
      repoRoot: process.cwd(),
      env: process.env,
      hookPath: "missing-hook.mjs",
      name: "spawn-error",
      body: "",
      timeoutMs: 30_000,
      spawnImpl: (() => {
        const child = new EventEmitter() as EventEmitter & {
          kill: () => boolean;
          stderr: EventEmitter;
          stdout: EventEmitter;
        };
        child.stderr = new EventEmitter();
        child.stdout = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("error", new Error("spawn denied")));
        return child;
      }) as unknown as typeof spawn,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toMatchObject({
      code: null,
      error: "spawn denied",
      name: "spawn-error",
      signal: null,
      timedOut: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "cleans timeout descendants before resolving the case",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-timeout-"));
      const hookPath = path.join(root, "rss-hook.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let descendantPid = 0;
      try {
        writeFileSync(hookPath, "", "utf8");
        const descendantScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const body = [
          "const childProcess = await import('node:child_process');",
          "const fs = await import('node:fs');",
          "const descendant = childProcess.spawn(process.execPath, [",
          "  '--input-type=module',",
          `  '--eval', ${JSON.stringify(descendantScript)},`,
          "], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const resultPromise = runCase({
          body,
          env: process.env,
          hookPath,
          name: "timeout-descendant",
          repoRoot: root,
          shutdownGraceMs: 100,
          timeoutMs: 250,
        });

        await waitForCondition(() => existsSync(descendantPidPath));
        descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await expect(resultPromise).resolves.toMatchObject({
          name: "timeout-descendant",
          signal: "SIGKILL",
          timedOut: true,
        });
        await waitForCondition(() => !isProcessAlive(descendantPid));
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans active case descendants on parent signal",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-parent-signal-"));
      const hookPath = path.join(root, "rss-hook.mjs");
      const runnerPath = path.join(root, "parent-signal-runner.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let descendantPid = 0;
      try {
        writeFileSync(hookPath, "", "utf8");
        const descendantScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const body = [
          "const childProcess = await import('node:child_process');",
          "const fs = await import('node:fs');",
          "const descendant = childProcess.spawn(process.execPath, [",
          "  '--input-type=module',",
          `  '--eval', ${JSON.stringify(descendantScript)},`,
          "], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        writeFileSync(
          runnerPath,
          [
            `const { runCase } = await import(${JSON.stringify(
              pathToFileURL(path.resolve("scripts/profile-extension-memory.mjs")).href,
            )});`,
            "void runCase({",
            `  body: ${JSON.stringify(body)},`,
            "  env: process.env,",
            `  hookPath: ${JSON.stringify(hookPath)},`,
            "  name: 'parent-signal-descendant',",
            `  repoRoot: ${JSON.stringify(root)},`,
            "  shutdownGraceMs: 100,",
            "  timeoutMs: 30000,",
            "});",
          ].join("\n"),
          "utf8",
        );
        const runner = spawn(process.execPath, [runnerPath], {
          stdio: "ignore",
        });

        try {
          await waitForCondition(() => existsSync(descendantPidPath));
          descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
          expect(Number.isInteger(descendantPid)).toBe(true);
          expect(isProcessAlive(descendantPid)).toBe(true);

          const runnerExit = waitForChildExit(runner);
          process.kill(runner.pid!, "SIGTERM");
          await expect(runnerExit).resolves.toEqual({ status: 143, signal: null });
          await waitForCondition(() => !isProcessAlive(descendantPid));
        } finally {
          if (runner.pid && isProcessAlive(runner.pid)) {
            process.kill(runner.pid, "SIGKILL");
          }
        }
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
