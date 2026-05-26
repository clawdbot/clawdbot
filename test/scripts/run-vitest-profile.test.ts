import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVitestProfileSpawnSpec,
  buildVitestProfileCommand,
  buildVitestProfileCommandWithArgs,
  parseArgs,
  resolveVitestProfileDir,
} from "../../scripts/run-vitest-profile.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

describe("scripts/run-vitest-profile", () => {
  const { trackTempDir } = createScriptTestHarness();

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

  it("builds main-thread cpu profiling args", () => {
    expect(buildVitestProfileCommand({ mode: "main", outputDir: "/tmp/profile-main" })).toEqual({
      command: process.execPath,
      args: [
        "--cpu-prof",
        "--cpu-prof-dir=/tmp/profile-main",
        "./node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.unit.config.ts",
        "--no-file-parallelism",
      ],
    });
  });

  it("builds runner cpu and heap profiling args", () => {
    expect(buildVitestProfileCommand({ mode: "runner", outputDir: "/tmp/profile-runner" })).toEqual(
      {
        command: "pnpm",
        args: [
          "vitest",
          "run",
          "--config",
          "test/vitest/vitest.unit.config.ts",
          "--no-file-parallelism",
          "--execArgv=--cpu-prof",
          "--execArgv=--cpu-prof-dir=/tmp/profile-runner",
          "--execArgv=--heap-prof",
          "--execArgv=--heap-prof-dir=/tmp/profile-runner",
        ],
      },
    );
  });

  it("uses the Windows-safe pnpm fallback for runner profiling", () => {
    const spawnSpec = buildVitestProfileSpawnSpec(
      {
        command: "pnpm",
        args: ["vitest", "run"],
      },
      {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        npmExecPath: "",
        platform: "win32",
      },
    );

    expect(spawnSpec.options.shell).toBe(false);
    expect(spawnSpec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spawnSpec.options.windowsVerbatimArguments).toBe(true);
    expect(spawnSpec.args).toEqual(["/d", "/s", "/c", "pnpm.cmd vitest run"]);
  });

  it("parses mode and explicit output dir", () => {
    expect(parseArgs(["runner", "--output-dir", "/tmp/out"])).toEqual({
      mode: "runner",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
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
