import { describe, expect, it } from "vitest";
import { loadVitestExperimentalConfig } from "./vitest/vitest.performance-config.ts";

describe("loadVitestExperimentalConfig", () => {
  it("enables the filesystem module cache by default", () => {
    expect(loadVitestExperimentalConfig({}, "linux")).toEqual({
      experimental: {
        fsModuleCache: true,
      },
    });
  });

  it("enables the filesystem module cache explicitly", () => {
    expect(
      loadVitestExperimentalConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
        },
        "linux",
      ),
    ).toEqual({
      experimental: {
        fsModuleCache: true,
      },
    });
  });

  it("passes through the filesystem module cache path when provided", () => {
    expect(
      loadVitestExperimentalConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/openclaw-vitest-cache",
        },
        "linux",
      ),
    ).toEqual({
      experimental: {
        fsModuleCache: true,
        fsModuleCachePath: "/tmp/openclaw-vitest-cache",
      },
    });
  });

  it("disables the filesystem module cache by default on Windows", () => {
    expect(loadVitestExperimentalConfig({}, "win32")).toStrictEqual({});
  });

  it("still allows enabling the filesystem module cache explicitly on Windows", () => {
    expect(
      loadVitestExperimentalConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
        },
        "win32",
      ),
    ).toEqual({
      experimental: {
        fsModuleCache: true,
      },
    });
  });

  it("allows disabling the filesystem module cache explicitly", () => {
    expect(
      loadVitestExperimentalConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "0",
        },
        "linux",
      ),
    ).toStrictEqual({});
  });

  it("enables import timing output and import breakdown reporting", () => {
    expect(
      loadVitestExperimentalConfig(
        {
          OPENCLAW_VITEST_IMPORT_DURATIONS: "true",
          OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN: "1",
        },
        "linux",
      ),
    ).toEqual({
      experimental: {
        fsModuleCache: true,
        importDurations: { print: true },
        printImportBreakdown: true,
      },
    });
  });

  it("uses RUNNER_OS to detect Windows even when the platform is not win32", () => {
    expect(loadVitestExperimentalConfig({ RUNNER_OS: "Windows" }, "linux")).toStrictEqual({});
  });
});
