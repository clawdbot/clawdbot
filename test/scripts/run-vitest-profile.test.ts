// Run Vitest Profile tests cover run vitest profile script behavior.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildVitestProfileCommandWithArgs,
  parseArgs,
  resolveVitestProfileDir,
} from "../../scripts/run-vitest-profile.mts";
import { createScriptTestHarness } from "./test-helpers.js";

function runProfileProcess(command: string, args: string[], root: string) {
  return promisify(execFile)(command, args, {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CI: "1" },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({
      code: error.code,
      output: error.stdout + error.stderr,
    }),
  );
}

describe("scripts/run-vitest-profile", () => {
  const { createTempDir, trackTempDir } = createScriptTestHarness();
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  it("defaults profile output outside the repo", () => {
    const outputDir = trackTempDir(resolveVitestProfileDir({ mode: "main", outputDir: "" }));

    expect(outputDir.startsWith(os.tmpdir())).toBe(true);
    expect(outputDir.startsWith(process.cwd())).toBe(false);
  });

  it("keeps explicit output directories", () => {
    expect(
      resolveVitestProfileDir({ mode: "runner", outputDir: ".artifacts/custom-profile" }),
    ).toBe(path.resolve(".artifacts/custom-profile"));
  });

  it.each(["main", "runner"])(
    "launches %s without shell parsing and preserves Vitest arguments",
    (mode) => {
      const outputDir = path.join(os.tmpdir(), "profile with spaces");
      const forwarded = [
        "--config",
        "custom config.ts",
        "--pool",
        "threads",
        "--isolate",
        "--runner",
        "custom runner.ts",
      ];
      const plan = buildVitestProfileCommandWithArgs({ mode, outputDir, vitestArgs: forwarded });
      expect(plan.command).toBe(process.execPath);
      expect(plan.args.slice(1, 3)).toEqual([mode, outputDir]);
      expect(plan.args.slice(-forwarded.length)).toEqual(forwarded);
    },
  );

  it.each(
    [
      { pool: "forks", isolate: true, custom: false, failRun: false },
      { pool: "threads", isolate: true, custom: false, failRun: true },
      { pool: "forks", isolate: false, custom: false, failRun: true },
      { pool: "threads", isolate: false, custom: false, failRun: false },
      { pool: "forks", isolate: true, custom: true, failRun: true },
      { pool: "threads", isolate: true, custom: true, failRun: false },
      { pool: "forks", isolate: true, custom: true, failRun: false, projects: true },
    ].map((testCase) => ({ projects: false, ...testCase })),
  )(
    "profiles selected $pool runner (isolated: $isolate, custom: $custom, failed: $failRun, projects: $projects)",
    async ({ pool, isolate, custom, failRun, projects }) => {
      const root = createTempDir("oc-profile-sibling-");
      fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}');
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const environment = custom && pool === "threads" ? "jsdom" : "node";
      const configPath = path.join(root, "custom.config.ts");
      fs.writeFileSync(
        configPath,
        `export default { test: {
  include: ["*.test.ts"], exclude: ["config-excluded.test.ts"], reporters: ["default", "json"], outputFile: "report.json",
  globalSetup: "./custom-setup.ts",
  ${projects ? `projects: ["first", "second"].map(name => ({ test: { name, include: [name + ".test.ts"], runner: ${JSON.stringify(path.join(root, "custom-runner.ts"))} } })),` : ""}
} };`,
      );
      for (const name of ["config-excluded", "cli-excluded"]) {
        fs.writeFileSync(
          path.join(root, name + ".test.ts"),
          'throw new Error("excluded files must not run");',
        );
      }
      fs.writeFileSync(
        path.join(root, "custom-setup.ts"),
        `export function setup(project) {
  project.provide("customSetupCount", (project.getProvidedContext().customSetupCount ?? 0) + 1);
}`,
      );
      const customRunner = path.join(root, "custom-runner.ts");
      fs.writeFileSync(
        customRunner,
        `import { TestRunner } from "vitest";
export default class extends TestRunner {
  onCollectStart(file) { super.onCollectStart(file); globalThis.profileCustomRunner = true; }
}`,
      );
      for (const name of ["first", "second"]) {
        fs.writeFileSync(
          path.join(root, `${name}.test.ts`),
          `import fs from "node:fs";
import { isMainThread, threadId } from "node:worker_threads";
import { expect, inject, it, vi } from "vitest";
it("retains the selected execution context", async () => {
  vi.resetModules();
  expect(inject("customSetupCount")).toBe(1);
  expect(isMainThread).toBe(${pool === "forks"});
  expect(globalThis.profileCustomRunner === true).toBe(${custom});
  expect(typeof document).toBe(${JSON.stringify(environment === "jsdom" ? "object" : "undefined")});
  ${
    environment === "jsdom" && name === "first"
      ? `const unrelatedModule = ${JSON.stringify(path.join(repoRoot, "scripts/lib/error-format.mts"))};
  await expect(import(unrelatedModule)).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });`
      : ""
  }
  fs.writeFileSync(${JSON.stringify(path.join(root, name + ".json"))}, JSON.stringify({ pid: process.pid, threadId }));
  ${failRun && name === "second" ? 'expect.fail("intentional profiling sibling failure");' : ""}
});`,
        );
      }
      const outputDir = path.join(root, "profiles with spaces");
      const args = [
        path.join(repoRoot, "scripts/run-vitest-profile.mts"),
        "runner",
        "--output-dir",
        outputDir,
        "--",
        "--config",
        configPath,
        "--configLoader",
        "native",
        "--pool",
        pool,
        `--isolate=${isolate}`,
        "--maxWorkers",
        "1",
        "--environment",
        environment,
        "--exclude",
        "cli-excluded.test.ts",
      ];
      if (custom && !projects) args.push("--runner", customRunner);
      if (projects) args.push("--reporter", "json");
      const result = await runProfileProcess(process.execPath, args, root);
      const reportPath = path.join(root, "report.json");
      const reportText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
      expect(result.code, `${result.output}\n${reportText}`).toBe(failRun ? 1 : 0);
      if (failRun) {
        expect(result.output.trimEnd()).toMatch(/\[run-vitest-profile\] FAILED \(exit 1\)$/u);
      }
      const report = JSON.parse(reportText);
      expect(report.numTotalTests).toBe(2);
      expect(report.numFailedTests).toBe(failRun ? 1 : 0);
      const profiles = fs.readdirSync(outputDir);
      for (const name of ["first", "second"]) {
        const { pid, threadId } = JSON.parse(
          fs.readFileSync(path.join(root, name + ".json"), "utf8"),
        );
        const cpuFiles = profiles.filter((file) => file.startsWith(`CPU.${pid}.${threadId}.`));
        const heapFiles = profiles.filter((file) => file.startsWith(`Heap.${pid}.${threadId}.`));
        // Repeated files share one sampler unless Vitest actually creates another worker.
        expect(cpuFiles, result.output).toHaveLength(1);
        expect(heapFiles, result.output).toHaveLength(1);
        const cpu = JSON.parse(fs.readFileSync(path.join(outputDir, cpuFiles[0]!), "utf8"));
        const heap = JSON.parse(fs.readFileSync(path.join(outputDir, heapFiles[0]!), "utf8"));
        expect(cpu.nodes.length).toBeGreaterThan(0);
        expect(cpu.samples.length).toBeGreaterThan(0);
        expect(cpu.endTime).toBeGreaterThan(cpu.startTime);
        expect(heap.head.children.length).toBeGreaterThan(0);
        expect(heap.samples.length).toBeGreaterThan(0);
      }
    },
  );

  it.each([
    { mode: "main", flag: "--help" },
    { mode: "runner", flag: "-h" },
  ])("prints $mode help without starting a test server", async ({ mode, flag }) => {
    const root = createTempDir("oc-profile-help-");
    const args = [
      path.join(repoRoot, "scripts/run-vitest-profile.mts"),
      mode,
      "--output-dir",
      path.join(root, "profiles"),
      "--",
      flag,
    ];
    const result = await runProfileProcess(process.execPath, args, root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Usage:");
  });

  it("retains the CLI startup error when profile output cannot be written", async () => {
    const root = createTempDir("oc-profile-errors-");
    const plan = buildVitestProfileCommandWithArgs({
      mode: "main",
      outputDir: path.join(root, "missing"),
      vitestArgs: ["--config", "first.config.ts", "--config", "second.config.ts"],
    });
    const result = await runProfileProcess(plan.command, plan.args, root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("Expected a single value");
    expect(result.output).toContain("ENOENT");
  });

  it("parses mode and explicit output dir", () => {
    expect(parseArgs(["runner", "--output-dir", "/tmp/out"])).toEqual({
      mode: "runner",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
  });

  it("rejects missing profile output directories", () => {
    expect(() => parseArgs(["runner", "--output-dir"])).toThrow("Expected --output-dir <dir>.");
    expect(() => parseArgs(["runner", "--output-dir", "-h"])).toThrow(
      "Expected --output-dir <dir>.",
    );
    expect(() => parseArgs(["runner", "--output-dir", "--", "--config", "custom.ts"])).toThrow(
      "Expected --output-dir <dir>.",
    );
  });

  it("passes vitest args after a separator", () => {
    expect(parseArgs(["main", "--output-dir", "/tmp/out", "--", "--config", "custom.ts"])).toEqual({
      mode: "main",
      outputDir: "/tmp/out",
      vitestArgs: ["--config", "custom.ts"],
    });
    expect(
      buildVitestProfileCommandWithArgs({
        mode: "runner",
        outputDir: "/tmp/profile-runner",
        vitestArgs: ["src/example.test.ts"],
      }).args,
    ).toContain("src/example.test.ts");
  });

  it("allows a package-script separator before script flags", () => {
    expect(parseArgs(["main", "--", "--output-dir", "/tmp/out"])).toEqual({
      mode: "main",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
  });
});
