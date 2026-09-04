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
  const cli = path.join(
    path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const run = (
    root: string,
    checkout: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = {},
    expectedStatus = 0,
  ) => {
    const result = spawnSync(
      process.execPath,
      [cli, "run", "--config", path.join(checkout, "vitest.config.mjs"), ...args],
      {
        cwd: checkout,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          CI: "1",
          HOME: root,
          ...env,
        },
        timeout: 15_000,
      },
    );
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(
      expectedStatus,
    );
    return result;
  };

  it("preserves another checkout's cache when shared dependencies change", () => {
    const root = tempDirs.make("oc-vitest-cache-ownership-");
    const sharedModules = path.join(root, "shared", "node_modules");
    fs.mkdirSync(path.join(sharedModules, ".pnpm"), { recursive: true });
    const lockfile = path.join(sharedModules, ".pnpm", "lock.yaml");
    fs.writeFileSync(lockfile, "lockfileVersion: 1\n");
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
    const first = prepareCheckout("first");
    const second = prepareCheckout("second");
    run(root, first.checkout);
    const firstCache =
      first.cacheConfig.experimental?.fsModuleCachePath ??
      path.join(sharedModules, ".experimental-vitest-cache");
    const sentinel = path.join(firstCache, "first-checkout-sentinel");
    fs.writeFileSync(sentinel, "owned by first checkout");
    fs.writeFileSync(lockfile, "lockfileVersion: 2\n");
    run(root, second.checkout);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned by first checkout");
  });

  it("reuses shared project transforms after a lock transition without serving a stale later project", () => {
    const root = fs.realpathSync(tempDirs.make("oc-vitest-cache-projects-"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cache-projects", type: "module", workspaces: [] }),
    );
    const generation = path.join(root, "dependency-generation.txt");
    const transitionLock = (version: string) => {
      // bun.lock is only a recognized hash input; no package manager is invoked.
      fs.writeFileSync(path.join(root, "bun.lock"), JSON.stringify({ version }));
      fs.writeFileSync(generation, version);
    };
    transitionLock("1.0.0");
    for (const name of ["A", "B"]) {
      const project = path.join(root, name);
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, "transforms.txt"), "");
      fs.writeFileSync(
        path.join(project, "subject.js"),
        'export const version = "__DEPENDENCY_VERSION__";\n',
      );
      fs.copyFileSync(
        path.join(project, "subject.js"),
        path.join(project, "configured-subject.js"),
      );
      fs.copyFileSync(path.join(project, "subject.js"), path.join(project, "body-subject.js"));
      fs.writeFileSync(
        path.join(project, "fixture.test.js"),
        `import { appendFileSync, readFileSync } from "node:fs";
import { version } from "fixture-subject";
const events = ${JSON.stringify(path.join(project, "events.txt"))};
appendFileSync(events, "collect:" + version + "\\n");
beforeAll(() => appendFileSync(events, "beforeAll\\n"));
test("executes the current dependency generation", async () => {
  appendFileSync(events, "body\\n");
  expect(version).toBe(readFileSync(${JSON.stringify(generation)}, "utf8"));
  const { version: bodyVersion } = await import("./body-subject.js");
  expect(bodyVersion).toBe(readFileSync(${JSON.stringify(generation)}, "utf8"));
});
`,
      );
    }
    const shardOwner = new URL("./vitest/vitest.project-shard-config.ts", import.meta.url).href;
    const scopedOwner = new URL("./vitest/vitest.scoped-config.ts", import.meta.url).href;
    const configFile = path.join(root, "vitest.config.mjs");
    fs.writeFileSync(
      configFile,
      `import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createProjectShardVitestConfig } from ${JSON.stringify(shardOwner)};
import { createScopedVitestConfig } from ${JSON.stringify(scopedOwner)};
const root = ${JSON.stringify(root)};
const aggregate = createProjectShardVitestConfig([]);
const scoped = createScopedVitestConfig([], { env: {}, argv: [] });
const subjectFile = "subject.js";
export default {
  root,
  test: {
    experimental: aggregate.test.experimental,
    projects: ["A", "B"].map((name) => ({
      extends: false,
      root: path.join(root, name),
      resolve: { alias: { "fixture-subject": path.join(root, name, subjectFile) } },
      plugins: [{
        name: "fixture-external-plugin",
        transform(code, id) {
          const isSubject = id === path.join(root, name, subjectFile).replaceAll("\\\\", "/");
          if (!isSubject && id !== path.join(root, name, "body-subject.js").replaceAll("\\\\", "/")) return;
          // External plugin generations are outside the config/source graph;
          // the paired lock change must invalidate their old transform output.
          const version = readFileSync(${JSON.stringify(generation)}, "utf8");
          const log = isSubject ? "transforms.txt" : "body-transforms.txt";
          appendFileSync(path.join(root, name, log), version + "\\n");
          return { code: code.replace("__DEPENDENCY_VERSION__", version), map: null };
        },
      }],
      test: {
        name,
        globals: true,
        include: ["fixture.test.js"],
        experimental: scoped.test.experimental,
      },
    })),
  },
};
`,
    );
    const cacheConfig = loadVitestExperimentalConfig({}, "linux", root);
    const env = {
      OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: cacheConfig.experimental?.fsModuleCachePath,
    };
    const check = (projects: string[], expected: [number, number], args: string[] = []) => {
      run(root, root, [...projects.flatMap((name) => ["--project", name]), ...args], env);
      const counts = ["A", "B"].map(
        (name) =>
          fs.readFileSync(path.join(root, name, "transforms.txt"), "utf8").split("\n").length - 1,
      );
      expect(counts, `subject transforms after selecting ${projects.join("+")}`).toEqual(expected);
    };
    check(["A", "B"], [1, 1], ["--testNamePattern=(?!)"]);
    for (const name of ["A", "B"]) {
      expect(fs.readFileSync(path.join(root, name, "events.txt"), "utf8")).toBe("collect:1.0.0\n");
      expect(fs.existsSync(path.join(root, name, "body-transforms.txt"))).toBe(false);
    }
    check(["A", "B"], [1, 1]);
    for (const name of ["A", "B"]) {
      expect(fs.readFileSync(path.join(root, name, "events.txt"), "utf8")).toBe(
        "collect:1.0.0\ncollect:1.0.0\nbeforeAll\nbody\n",
      );
      expect(fs.readFileSync(path.join(root, name, "body-transforms.txt"), "utf8")).toBe("1.0.0\n");
    }
    transitionLock("2.0.0");
    check(["A"], [2, 1]);
    check(["A"], [2, 1]);
    check(["B"], [2, 2]);
    check(["B"], [2, 2]);

    // Reuse must still respect ordinary source and config invalidation.
    fs.appendFileSync(path.join(root, "A", "subject.js"), "\n// source edit\n");
    check(["A", "B"], [3, 2]);
    fs.writeFileSync(
      configFile,
      fs
        .readFileSync(configFile, "utf8")
        .replace(
          'const subjectFile = "subject.js";',
          'const subjectFile = "configured-subject.js";',
        ),
    );
    check(["A", "B"], [4, 3]);
    check(["A", "B"], [4, 3]);

    fs.appendFileSync(
      path.join(root, "A", "configured-subject.js"),
      '\nthrow new Error("fixture collection import failure");\n',
    );
    const failedCollection = run(root, root, ["--project", "A", "--testNamePattern=(?!)"], env, 1);
    expect(`${failedCollection.stdout}\n${failedCollection.stderr}`).toContain(
      "fixture collection import failure",
    );
  });
});
