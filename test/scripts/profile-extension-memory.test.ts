// Profile Extension Memory tests cover profile extension memory script behavior.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, runCase } from "../../scripts/profile-extension-memory.mjs";

const SCRIPT_PATH = path.resolve("scripts/profile-extension-memory.mjs");

function runProfileExtensionMemory(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
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
      spawnImpl: () => {
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
      },
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
});
