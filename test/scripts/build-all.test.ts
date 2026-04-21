import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_ALL_PROFILES,
  BUILD_ALL_STEPS,
  resolveBuildAllStepCacheState,
  resolveBuildAllStep,
  resolveBuildAllSteps,
  restoreBuildAllStepCacheOutputs,
  writeBuildAllStepCacheStamp,
} from "../../scripts/build-all.mjs";

function withBuildCacheFixture(
  run: (fixture: {
    rootDir: string;
    inputPath: string;
    outputPath: string;
    step: {
      label: string;
      cache: {
        inputs: string[];
        outputs: string[];
      };
    };
  }) => void,
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-cache-"));
  try {
    const inputPath = path.join(rootDir, "src/input.ts");
    const outputPath = path.join(rootDir, "dist/output.js");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(inputPath, "input");
    fs.writeFileSync(outputPath, "output");
    run({
      rootDir,
      inputPath,
      outputPath,
      step: {
        label: "cached",
        cache: {
          inputs: ["src"],
          outputs: ["dist"],
        },
      },
    });
  } finally {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
}

describe("resolveBuildAllStep", () => {
  it("routes pnpm steps through the npm_execpath pnpm runner on Windows", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "canvas:a2ui:bundle");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: {},
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs", "canvas:a2ui:bundle"],
      options: {
        stdio: "inherit",
        env: {},
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("keeps node steps on the current node binary", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "runtime-postbuild");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["scripts/runtime-postbuild.mjs"],
      options: {
        stdio: "inherit",
        env: { FOO: "bar" },
      },
    });
  });

  it("adds heap headroom for plugin-sdk dts on Windows", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "build:plugin-sdk:dts");
    expect(step).toBeTruthy();

    const result = resolveBuildAllStep(step, {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs", "build:plugin-sdk:dts"],
      options: {
        stdio: "inherit",
        env: {
          FOO: "bar",
          NODE_OPTIONS: "--max-old-space-size=4096",
        },
        shell: false,
        windowsVerbatimArguments: undefined,
      },
    });
  });
});

describe("resolveBuildAllSteps", () => {
  it("keeps the full profile aligned with the declared steps", () => {
    expect(resolveBuildAllSteps("full")).toEqual(BUILD_ALL_STEPS);
    expect(BUILD_ALL_PROFILES.full).toEqual(BUILD_ALL_STEPS.map((step) => step.label));
  });

  it("uses a runtime-only profile for ci artifacts", () => {
    expect(resolveBuildAllSteps("ciArtifacts").map((step) => step.label)).toEqual([
      "canvas:a2ui:bundle",
      "tsdown",
      "runtime-postbuild",
      "write-npm-update-compat-sidecars",
      "build-stamp",
      "canvas-a2ui-copy",
      "copy-hook-metadata",
      "copy-export-html-templates",
      "write-build-info",
      "write-cli-startup-metadata",
      "write-cli-compat",
    ]);
  });

  it("does not cache plugin-sdk entry shims over compiled JS", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "write-plugin-sdk-entry-dts");
    expect(step).toBeTruthy();
    expect(step?.cache).toBeUndefined();
  });

  it("does not cache hook metadata over compiled hook handlers", () => {
    const step = BUILD_ALL_STEPS.find((entry) => entry.label === "copy-hook-metadata");
    expect(step).toBeTruthy();
    expect(step?.cache).toBeUndefined();
  });

  it("rejects unknown build profiles", () => {
    expect(() => resolveBuildAllSteps("wat")).toThrow("Unknown build profile: wat");
  });
});

describe("resolveBuildAllStepCacheState", () => {
  it("marks cacheable steps fresh when the input signature matches", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });

      expect(resolveBuildAllStepCacheState(step, { rootDir })).toMatchObject({
        cacheable: true,
        fresh: true,
        reason: "fresh",
        inputFiles: 1,
        outputFiles: 1,
      });
    });
  });

  it("marks cacheable steps stale when an input changes", () => {
    withBuildCacheFixture(({ rootDir, inputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.writeFileSync(inputPath, "changed");

      expect(resolveBuildAllStepCacheState(step, { rootDir })).toMatchObject({
        cacheable: true,
        fresh: false,
        reason: "stale",
      });
    });
  });

  it("restores cached outputs when generated files were removed", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.rmSync(path.join(rootDir, "dist"), { force: true, recursive: true });

      const restorable = resolveBuildAllStepCacheState(step, { rootDir });
      expect(restorable).toMatchObject({
        cacheable: true,
        fresh: true,
        reason: "fresh-cache",
        restorable: true,
      });
      expect(restoreBuildAllStepCacheOutputs(restorable, { rootDir })).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("output");
    });
  });
});
