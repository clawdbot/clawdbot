import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_ALL_PROFILES,
  BUILD_ALL_PROFILE_STEP_ENV,
  BUILD_ALL_STEPS,
  buildAllUsage,
  formatBuildAllDuration,
  formatBuildAllTimingSummary,
  parseBuildAllArgs,
  resolveBuildAllStepCacheState,
  resolveBuildAllStep,
  resolveBuildAllSteps,
  restoreBuildAllStepCacheOutputs,
  writeBuildAllStepCacheStamp,
} from "../../scripts/build-all.mjs";

function getBuildAllStep(label: string) {
  const step = BUILD_ALL_STEPS.find((entry) => entry.label === label);
  if (!step) {
    throw new Error(`Missing build-all step ${label}`);
  }
  return step;
}

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
    const step = getBuildAllStep("plugins:assets:build");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.cjs");
    fs.writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      const result = resolveBuildAllStep(step, {
        platform: "win32",
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath,
        env: {},
      });

      expect(result).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [npmExecPath, "plugins:assets:build"],
        options: {
          stdio: "inherit",
          env: {},
          shell: false,
          windowsVerbatimArguments: undefined,
        },
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps node steps on the current node binary", () => {
    const step = getBuildAllStep("runtime-postbuild");

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

  it("can route pnpm script steps through direct node entrypoints", () => {
    const step = getBuildAllStep("plugins:assets:build");

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["scripts/bundled-plugin-assets.mjs", "--phase", "build"],
      options: {
        stdio: "inherit",
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
      },
    });
  });

  it("adds heap headroom for plugin-sdk dts on Windows", () => {
    const step = getBuildAllStep("build:plugin-sdk:dts");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.cjs");
    fs.writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      const result = resolveBuildAllStep(step, {
        platform: "win32",
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath,
        env: { FOO: "bar" },
      });

      expect(result).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [npmExecPath, "build:plugin-sdk:dts"],
        options: {
          stdio: "inherit",
          env: {
            FOO: "bar",
            NODE_OPTIONS: "--max-old-space-size=8192",
          },
          shell: false,
          windowsVerbatimArguments: undefined,
        },
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps plugin-sdk dts cache metadata aligned with declaration inputs", () => {
    const step = getBuildAllStep("build:plugin-sdk:dts");

    expect(step.cache?.inputs).toEqual(expect.arrayContaining(["packages/memory-host-sdk/src"]));
    expect(step.cache?.inputs).toEqual(expect.arrayContaining(["npm-shrinkwrap.json"]));
    expect(step.cache?.outputs).toEqual(expect.arrayContaining(["dist/plugin-sdk/packages"]));
  });
});

describe("resolveBuildAllSteps", () => {
  it("parses build-all CLI args before any build work", () => {
    expect(parseBuildAllArgs([])).toEqual({ help: false, profile: "full" });
    expect(parseBuildAllArgs(["cliStartup"])).toEqual({ help: false, profile: "cliStartup" });
    expect(parseBuildAllArgs(["cliStartup", "--help"])).toEqual({
      help: true,
      profile: "cliStartup",
    });
    expect(() => parseBuildAllArgs(["cliStartup", "--bogus"])).toThrow("unknown argument: --bogus");
    expect(() => parseBuildAllArgs(["wat"])).toThrow("Unknown build profile: wat");
  });

  it("prints CLI help without starting build steps", () => {
    for (const args of [["--help"], ["cliStartup", "--help"]]) {
      const result = spawnSync(process.execPath, ["scripts/build-all.mjs", ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: node scripts/build-all.mjs [profile]");
      expect(result.stdout).toContain("cliStartup");
      expect(result.stdout).not.toContain("[build-all]");
    }
  });

  it("rejects unknown CLI args without starting build steps", () => {
    const result = spawnSync(process.execPath, ["scripts/build-all.mjs", "cliStartup", "--bogus"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain(buildAllUsage());
    expect(result.stderr).not.toContain("[build-all]");
    expect(result.stderr).not.toContain("at ");
  });

  it("keeps the full profile aligned with the declared steps", () => {
    expect(resolveBuildAllSteps("full").map((step) => step.label)).toEqual(
      BUILD_ALL_STEPS.map((step) => step.label),
    );
    expect(BUILD_ALL_PROFILES.full).toEqual(BUILD_ALL_STEPS.map((step) => step.label));
  });

  it("uses a runtime artifact plus plugin SDK export profile for ci artifacts", () => {
    expect(resolveBuildAllSteps("ciArtifacts").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "build:plugin-sdk:dts",
      "write-plugin-sdk-entry-dts",
      "check-plugin-sdk-exports",
      "plugins:assets:copy",
      "copy-hook-metadata",
      "copy-export-html-templates",
      "ui:build",
      "write-build-info",
      "write-cli-startup-metadata",
      "write-cli-compat",
    ]);
  });

  it("skips bundled tsdown declarations for runtime-only profiles", () => {
    for (const profile of ["ciArtifacts", "gatewayWatch", "qaRuntime", "cliStartup"]) {
      const tsdown = resolveBuildAllSteps(profile).find((step) => step.label === "tsdown");
      if (!tsdown) {
        throw new Error(`Missing ${profile} tsdown step`);
      }

      expect(BUILD_ALL_PROFILE_STEP_ENV[profile].tsdown).toMatchObject({
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      });
      expect(
        resolveBuildAllStep(tsdown, { env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" } }).options.env,
      ).toMatchObject({
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      });
    }
  });

  it("preserves startup metadata only for profiles that regenerate it", () => {
    for (const profile of ["full", "ciArtifacts", "cliStartup"]) {
      const tsdown = resolveBuildAllSteps(profile).find((step) => step.label === "tsdown");
      if (!tsdown) {
        throw new Error(`Missing ${profile} tsdown step`);
      }

      expect(resolveBuildAllStep(tsdown, { env: {} }).options.env).toMatchObject({
        OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
      });
    }

    for (const profile of ["gatewayWatch", "qaRuntime"]) {
      const tsdown = resolveBuildAllSteps(profile).find((step) => step.label === "tsdown");
      if (!tsdown) {
        throw new Error(`Missing ${profile} tsdown step`);
      }

      expect(resolveBuildAllStep(tsdown, { env: {} }).options.env).not.toHaveProperty(
        "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA",
      );
    }
  });

  it("uses a minimal built runtime profile for gateway watch regression", () => {
    expect(resolveBuildAllSteps("gatewayWatch").map((step) => step.label)).toEqual([
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
    ]);
  });

  it("uses a QA runtime profile with generated plugin assets but no startup metadata", () => {
    expect(resolveBuildAllSteps("qaRuntime").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
    ]);
  });

  it("uses a CLI startup profile without generated plugin assets", () => {
    expect(resolveBuildAllSteps("cliStartup").map((step) => step.label)).toEqual([
      "tsdown",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "write-cli-startup-metadata",
      "write-cli-compat",
    ]);
  });

  it("skips generated static plugin assets for minimal backend-only profiles", () => {
    for (const profile of ["gatewayWatch", "cliStartup"]) {
      const runtimePostbuild = resolveBuildAllSteps(profile).find(
        (step) => step.label === "runtime-postbuild",
      );
      if (!runtimePostbuild) {
        throw new Error(`Missing ${profile} runtime-postbuild step`);
      }

      expect(BUILD_ALL_PROFILE_STEP_ENV[profile]["runtime-postbuild"]).toEqual({
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
      });
      expect(
        resolveBuildAllStep(runtimePostbuild, {
          env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "1" },
        }).options.env,
      ).toMatchObject({
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
      });
    }
  });

  it("keeps generated static plugin assets enabled for the QA runtime profile", () => {
    const runtimePostbuild = resolveBuildAllSteps("qaRuntime").find(
      (step) => step.label === "runtime-postbuild",
    );
    if (!runtimePostbuild) {
      throw new Error("Missing qaRuntime runtime-postbuild step");
    }

    expect(BUILD_ALL_PROFILE_STEP_ENV.qaRuntime["runtime-postbuild"]).toBeUndefined();
    expect(
      resolveBuildAllStep(runtimePostbuild, {
        env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "1" },
      }).options.env,
    ).toMatchObject({
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "1",
    });
  });

  it("writes the runtime postbuild stamp after the build stamp", () => {
    const labels = resolveBuildAllSteps("full").map((step) => step.label);
    expect(labels).toContain("runtime-postbuild");
    expect(labels).toContain("build-stamp");
    expect(labels).toContain("runtime-postbuild-stamp");
    expect(labels.indexOf("runtime-postbuild-stamp")).toBeGreaterThan(
      labels.indexOf("build-stamp"),
    );
  });

  it("includes ui:build in the full and ciArtifacts profiles after runtime postbuild", () => {
    for (const profile of ["full", "ciArtifacts"]) {
      const labels = resolveBuildAllSteps(profile).map((step) => step.label);
      expect(labels).toContain("ui:build");
      // Control UI bundling must run after tsdown clears dist so that
      // dist/control-ui survives `pnpm build` without a second command.
      expect(labels.indexOf("ui:build")).toBeGreaterThan(labels.indexOf("tsdown"));
      expect(labels.indexOf("ui:build")).toBeGreaterThan(labels.indexOf("runtime-postbuild-stamp"));
      // ui:build must run before write-build-info so the build manifest can
      // see the final dist/control-ui assets.
      expect(labels.indexOf("ui:build")).toBeLessThan(labels.indexOf("write-build-info"));
    }
  });

  it("keeps ui:build out of minimal backend-only profiles", () => {
    for (const profile of ["gatewayWatch", "qaRuntime", "cliStartup"]) {
      const labels = resolveBuildAllSteps(profile).map((step) => step.label);
      expect(labels).not.toContain("ui:build");
    }
  });

  it("does not cache ui:build because Vite reads package.json, git HEAD, and env metadata", () => {
    // ui/vite.config.ts derives the Control UI build ID from package.json,
    // git HEAD, and OPENCLAW_CONTROL_UI_BUILD_ID env, so a file-input
    // signature cannot exactly invalidate generated assets. Leaving this
    // step uncached avoids restoring stale service-worker/app cache
    // metadata after `tsdown` clears `dist`.
    const step = getBuildAllStep("ui:build");
    expect(step.kind).toBe("pnpm");
    expect(step.pnpmArgs).toEqual(["ui:build"]);
    expect(step.cache).toBeUndefined();
  });

  it("does not cache plugin-sdk entry shims over compiled JS", () => {
    const step = getBuildAllStep("write-plugin-sdk-entry-dts");
    expect(step.cache).toBeUndefined();
  });

  it("does not cache hook metadata over compiled hook handlers", () => {
    const step = getBuildAllStep("copy-hook-metadata");
    expect(step.cache).toBeUndefined();
  });

  it("rejects unknown build profiles", () => {
    expect(() => resolveBuildAllSteps("wat")).toThrow("Unknown build profile: wat");
  });
});

describe("build-all timing output", () => {
  it("formats short and long phase durations compactly", () => {
    expect(formatBuildAllDuration(42.4)).toBe("42ms");
    expect(formatBuildAllDuration(1234)).toBe("1.23s");
    expect(formatBuildAllDuration(12345)).toBe("12.3s");
  });

  it("summarizes phases slowest first with total time and status", () => {
    expect(
      formatBuildAllTimingSummary([
        { label: "tsdown", status: "ran", durationMs: 99000 },
        { label: "plugins:assets:copy", status: "cached", durationMs: 12 },
        { label: "build:plugin-sdk:dts", status: "ran", durationMs: 34567 },
      ]),
    ).toBe(
      "[build-all] phase timings: total 133.6s; slowest tsdown 99.0s; build:plugin-sdk:dts 34.6s; plugins:assets:copy (cached) 12ms",
    );
  });
});

describe("resolveBuildAllStepCacheState", () => {
  it("marks cacheable steps fresh when the input signature matches", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });

      const fresh = resolveBuildAllStepCacheState(step, { rootDir });
      expect(fresh.cacheable).toBe(true);
      expect(fresh.fresh).toBe(true);
      expect(fresh.reason).toBe("fresh");
      expect(fresh.inputFiles).toBe(1);
      expect(fresh.outputFiles).toBe(1);
      expect(fresh.restorable).toBe(false);
      expect(fresh.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(fresh.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof fresh.signature).toBe("string");
      expect(fresh.signature).toHaveLength(64);
      expect(fresh.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(fresh.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(fresh).toEqual({
        cacheable: true,
        fresh: true,
        inputFiles: 1,
        outputFiles: 1,
        outputRoot: fresh.outputRoot,
        reason: "fresh",
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: fresh.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: fresh.stampPath,
      });
    });
  });

  it("marks cacheable steps stale when an input changes", () => {
    withBuildCacheFixture(({ rootDir, inputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.writeFileSync(inputPath, "changed");

      const stale = resolveBuildAllStepCacheState(step, { rootDir });
      expect(stale.cacheable).toBe(true);
      expect(stale.fresh).toBe(false);
      expect(stale.reason).toBe("stale");
      expect(stale.inputFiles).toBe(1);
      expect(stale.outputFiles).toBe(1);
      expect(stale.restorable).toBe(false);
      expect(stale.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(stale.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof stale.signature).toBe("string");
      expect(stale.signature).toHaveLength(64);
      expect(stale.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(stale.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(stale).toEqual({
        cacheable: true,
        fresh: false,
        inputFiles: 1,
        outputFiles: 1,
        outputRoot: stale.outputRoot,
        reason: "stale",
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: stale.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: stale.stampPath,
      });
    });
  });

  it("restores cached outputs when generated files were removed", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.rmSync(path.join(rootDir, "dist"), { force: true, recursive: true });

      const restorable = resolveBuildAllStepCacheState(step, { rootDir });
      expect(restorable.cacheable).toBe(true);
      expect(restorable.fresh).toBe(true);
      expect(restorable.reason).toBe("fresh-cache");
      expect(restorable.inputFiles).toBe(1);
      expect(restorable.outputFiles).toBe(0);
      expect(restorable.restorable).toBe(true);
      expect(restorable.relativeOutputFiles).toEqual([]);
      expect(restorable.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof restorable.signature).toBe("string");
      expect(restorable.signature).toHaveLength(64);
      expect(restorable.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(restorable.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(restorable).toEqual({
        cacheable: true,
        fresh: true,
        inputFiles: 1,
        outputFiles: 0,
        outputRoot: restorable.outputRoot,
        reason: "fresh-cache",
        relativeOutputFiles: [],
        restorable: true,
        signature: restorable.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: restorable.stampPath,
      });
      expect(restoreBuildAllStepCacheOutputs(restorable, { rootDir })).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("output");
    });
  });
});
