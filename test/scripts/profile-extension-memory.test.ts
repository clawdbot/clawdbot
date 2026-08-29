// Profile Extension Memory tests cover profile extension memory script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs, runCase } from "../../scripts/profile-extension-memory.mts";

const SCRIPT_PATH = path.resolve("scripts/profile-extension-memory.mts");
const TSX_PRELOAD = path.resolve("scripts/tsx.mjs");
const SOURCE_TSCONFIG_PATH = path.resolve("tsconfig.json");

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
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
  return spawnSync(process.execPath, ["--import", TSX_PRELOAD, SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    // Fixture cwd controls artifacts; source imports still need the repository's aliases.
    env: { ...process.env, TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH },
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
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/profile-extension-memory.mts",
    );
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
    ] as const;

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

  it.each([
    {
      name: "package-local output without a root dist tree",
      files: ["extensions/external/dist/index.js"],
      selected: ["external"],
      expected: [{ dir: "external", file: "extensions/external/dist/index.js" }],
    },
    {
      name: "nested output in the root plugin tree",
      files: ["dist/extensions/external/dist/index.js"],
      selected: ["external"],
      expected: [{ dir: "external", file: "dist/extensions/external/dist/index.js" }],
    },
    ...[true, false].map((selected) => ({
      name: `mixed internal and external output (${selected ? "selected" : "default"})`,
      files: ["dist/extensions/internal/index.js", "extensions/external/dist/index.js"],
      selected: selected ? ["internal", "external"] : [],
      expected: [
        { dir: "external", file: "extensions/external/dist/index.js" },
        { dir: "internal", file: "dist/extensions/internal/index.js" },
      ],
    })),
    ...["index.js", "dist/index.js"].map((rootEntry) => ({
      name: `one canonical root ${rootEntry} when both builds exist`,
      files: [`dist/extensions/external/${rootEntry}`, "extensions/external/dist/index.js"],
      selected: ["external", "external"],
      expected: [{ dir: "external", file: `dist/extensions/external/${rootEntry}` }],
    })),
    {
      name: "source-only plugins excluded from default enumeration",
      files: ["dist/extensions/internal/index.js"],
      selected: [],
      expected: [{ dir: "internal", file: "dist/extensions/internal/index.js" }],
    },
  ])("profiles $name", ({ files, selected, expected }) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-")));
    try {
      for (const relativeFile of [
        ...files,
        "extensions/external/index.ts",
        "extensions/internal/index.ts",
        "extensions/source-only/index.ts",
      ]) {
        const file = path.join(root, relativeFile);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          file.endsWith(".ts") ? 'throw new Error("source imported");\n' : "export {};\n",
          "utf8",
        );
      }
      const reportPath = path.join(root, "report.json");
      const result = runProfileExtensionMemory(
        [
          ...selected.flatMap((id) => ["--extension", id]),
          "--concurrency",
          "1",
          "--json",
          reportPath,
        ],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("cliStartup");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.selectedExtensions).toEqual(expected.map(({ dir }) => dir));
      expect(report.results).toEqual(
        expected.map(({ dir, file }) =>
          expect.objectContaining({
            dir,
            file: path.join(root, file),
            status: "ok",
            maxRssMb: expect.any(Number),
          }),
        ),
      );
      expect(report.combined).toMatchObject({ status: "ok", maxRssMb: expect.any(Number) });
      expect(report.counts).toEqual({
        totalEntries: expected.length,
        ok: expected.length,
        fail: 0,
        timeout: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
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
          "import { writeFileSync } from 'node:fs';",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
          `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        ].join("");
        const body = [
          "const childProcess = await import('node:child_process');",
          "childProcess.spawn(process.execPath, [",
          "  '--input-type=module',",
          `  '--eval', ${JSON.stringify(descendantScript)},`,
          "], { stdio: 'ignore' });",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const child = spawn(
          process.execPath,
          ["--import", hookPath, "--input-type=module", "--eval", body],
          { cwd: root, detached: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
        );
        const childClosed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        try {
          await once(child, "spawn");
          await waitForCondition(() => {
            if (!existsSync(descendantPidPath)) {
              return false;
            }
            descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
            return Number.isInteger(descendantPid) && descendantPid > 0;
          });
          expect(Number.isInteger(descendantPid)).toBe(true);
          expect(isProcessAlive(descendantPid)).toBe(true);

          // Start the timeout only once a real descendant exists, independent of host startup load.
          const resultPromise = runCase({
            body,
            env: process.env,
            hookPath,
            name: "timeout-descendant",
            repoRoot: root,
            shutdownGraceMs: 100,
            timeoutMs: 250,
            spawnImpl: () => child,
          });
          await expect(resultPromise).resolves.toMatchObject({
            name: "timeout-descendant",
            signal: "SIGKILL",
            timedOut: true,
          });
          await waitForCondition(() => !isProcessAlive(descendantPid));
        } finally {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
                throw error;
              }
            }
          }
          await childClosed;
        }
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
              pathToFileURL(path.resolve("scripts/profile-extension-memory.mts")).href,
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
        const runner = spawn(process.execPath, ["--import", TSX_PRELOAD, runnerPath], {
          stdio: "ignore",
        });

        try {
          await waitForCondition(() => {
            if (!existsSync(descendantPidPath)) {
              return false;
            }
            const candidatePid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
            if (!Number.isInteger(candidatePid) || candidatePid <= 0) {
              return false;
            }
            descendantPid = candidatePid;
            return true;
          });
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
