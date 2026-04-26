import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPrefixedOutputWriter,
  isArtifactSetFresh,
  parseMode,
  runNodeSteps,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mjs";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("prepare-extension-package-boundary-artifacts", () => {
  it("prefixes each completed line and flushes the trailing partial line", () => {
    let output = "";
    const writer = createPrefixedOutputWriter("boundary", {
      write(chunk: string) {
        output += chunk;
      },
    });

    writer.write("first line\nsecond");
    writer.write(" line\nthird");
    writer.flush();

    expect(output).toBe("[boundary] first line\n[boundary] second line\n[boundary] third");
  });

  it("aborts sibling steps after the first failure", async () => {
    const startedAt = Date.now();
    const slowStepTimeoutMs = 60_000;
    const abortBudgetMs = 30_000;

    await expect(
      runNodeStepsInParallel([
        {
          label: "fail-fast",
          args: ["--eval", "process.exit(2)"],
          timeoutMs: slowStepTimeoutMs,
        },
        {
          label: "slow-step",
          args: ["--eval", "setTimeout(() => {}, 60_000)"],
          timeoutMs: slowStepTimeoutMs,
        },
      ]),
    ).rejects.toThrow("fail-fast failed with exit code 2");

    expect(Date.now() - startedAt).toBeLessThan(abortBudgetMs);
  }, 45_000);

  it("runs boundary prep steps serially for local checks", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-serial-"));
    tempRoots.add(rootDir);
    const logPath = path.join(rootDir, "steps.log");
    const appendScript = (label: string) =>
      `const fs=require("node:fs");` +
      `const log=${JSON.stringify(logPath)};` +
      `fs.appendFileSync(log, ${JSON.stringify(`${label}-start\n`)});` +
      `setTimeout(()=>{fs.appendFileSync(log, ${JSON.stringify(`${label}-end\n`)});}, 50);`;

    await runNodeSteps(
      [
        { label: "first", args: ["--eval", appendScript("first")], timeoutMs: 5_000 },
        { label: "second", args: ["--eval", appendScript("second")], timeoutMs: 5_000 },
      ],
      { OPENCLAW_LOCAL_CHECK: "1" },
    );

    expect(fs.readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  it("passes step-specific environment overrides to child steps", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-env-"));
    tempRoots.add(rootDir);
    const outputPath = path.join(rootDir, "env.txt");
    const writeEnvScript =
      `const fs=require("node:fs");` +
      `fs.writeFileSync(${JSON.stringify(outputPath)}, process.env.OPENCLAW_TEST_ENV || "", "utf8");`;

    await runNodeStepsInParallel([
      {
        label: "env-step",
        args: ["--eval", writeEnvScript],
        env: { OPENCLAW_TEST_ENV: "passed" },
        timeoutMs: 5_000,
      },
    ]);

    expect(fs.readFileSync(outputPath, "utf8")).toBe("passed");
  });

  it("treats artifacts as fresh only when outputs are newer than inputs", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-prep-"));
    tempRoots.add(rootDir);
    const inputPath = path.join(rootDir, "src", "demo.ts");
    const outputPath = path.join(rootDir, "dist", "demo.tsbuildinfo");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(inputPath, "export const demo = 1;\n", "utf8");
    fs.writeFileSync(outputPath, "ok\n", "utf8");

    fs.utimesSync(inputPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(outputPath, new Date(2_000), new Date(2_000));

    expect(
      isArtifactSetFresh({
        rootDir,
        inputPaths: ["src"],
        outputPaths: ["dist/demo.tsbuildinfo"],
      }),
    ).toBe(true);

    fs.utimesSync(inputPath, new Date(3_000), new Date(3_000));

    expect(
      isArtifactSetFresh({
        rootDir,
        inputPaths: ["src"],
        outputPaths: ["dist/demo.tsbuildinfo"],
      }),
    ).toBe(false);
  });

  it("parses prep mode and rejects unknown values", () => {
    expect(parseMode([])).toBe("all");
    expect(parseMode(["--mode=package-boundary"])).toBe("package-boundary");
    expect(() => parseMode(["--mode=nope"])).toThrow("Unknown mode: nope");
  });
});
