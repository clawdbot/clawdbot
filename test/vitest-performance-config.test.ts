// Vitest performance config tests validate performance test project setup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { loadVitestExperimentalConfig } from "./vitest/vitest.performance-config.ts";

describe("loadVitestExperimentalConfig", () => {
  it("enables the filesystem module cache by default", () => {
    expect(loadVitestExperimentalConfig({}, "linux")).toEqual({
      experimental: {
        fsModuleCache: true,
        fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
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
        fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
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
        fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
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
        fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
        importDurations: { print: true },
        printImportBreakdown: true,
      },
    });
  });

  it("uses RUNNER_OS to detect Windows even when the platform is not win32", () => {
    expect(loadVitestExperimentalConfig({ RUNNER_OS: "Windows" }, "linux")).toStrictEqual({});
  });
});

describe("filesystem module cache ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("preserves another checkout's cache when shared dependencies change", () => {
    const root = tempDirs.make("oc-vitest-cache-ownership-");
    const sharedModules = path.join(root, "shared", "node_modules");
    fs.mkdirSync(path.join(sharedModules, ".pnpm"), { recursive: true });
    const lockfile = path.join(sharedModules, ".pnpm", "lock.yaml");
    fs.writeFileSync(lockfile, "lockfileVersion: 1\n");
    const cli = path.join(
      path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
      "vitest.mjs",
    );
    const prepareCheckout = (name: string) => {
      const checkout = path.join(root, name);
      fs.mkdirSync(checkout);
      // Stop Vite's workspace search before it reaches this repository. The
      // symlink points only at this fixture's dependencies and writable cache.
      fs.writeFileSync(
        path.join(checkout, "package.json"),
        JSON.stringify({ name, type: "module", workspaces: [] }),
      );
      fs.symlinkSync(sharedModules, path.join(checkout, "node_modules"), "junction");
      fs.writeFileSync(
        path.join(checkout, "fixture.test.js"),
        'test("runs the fixture", () => expect(2 + 2).toBe(4));\n',
      );
      const cacheConfig = loadVitestExperimentalConfig({}, "linux", checkout);
      const config = {
        root: checkout,
        test: {
          globals: true,
          include: ["fixture.test.js"],
          maxWorkers: 1,
          ...cacheConfig,
        },
      };
      fs.writeFileSync(
        path.join(checkout, "vitest.config.mjs"),
        `export default ${JSON.stringify(config)};\n`,
      );
      return { checkout, cacheConfig };
    };
    const run = (checkout: string) => {
      const result = spawnSync(
        process.execPath,
        [cli, "run", "--config", path.join(checkout, "vitest.config.mjs")],
        {
          cwd: checkout,
          encoding: "utf8",
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: "1", HOME: root },
          timeout: 15_000,
        },
      );
      expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    };
    const first = prepareCheckout("first");
    const second = prepareCheckout("second");
    run(first.checkout);
    const firstCache =
      first.cacheConfig.experimental?.fsModuleCachePath ??
      path.join(sharedModules, ".experimental-vitest-cache");
    const sentinel = path.join(firstCache, "first-checkout-sentinel");
    fs.writeFileSync(sentinel, "owned by first checkout");
    fs.writeFileSync(lockfile, "lockfileVersion: 2\n");
    run(second.checkout);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned by first checkout");
  });
});
