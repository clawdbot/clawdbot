// Vitest performance config tests validate performance test project setup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeEvalArgs } from "../src/test-utils/node-process.ts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { loadVitestPerformanceConfig } from "./vitest/vitest.performance-config.ts";

describe("loadVitestPerformanceConfig", () => {
  it("enables the filesystem module cache by default", () => {
    expect(loadVitestPerformanceConfig({}, "linux")).toEqual({
      fsModuleCache: true,
      fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
    });
  });

  it("enables the filesystem module cache explicitly", () => {
    expect(
      loadVitestPerformanceConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
        },
        "linux",
      ),
    ).toEqual({
      fsModuleCache: true,
      fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
    });
  });

  it("passes through the filesystem module cache path when provided", () => {
    expect(
      loadVitestPerformanceConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/openclaw-vitest-cache",
        },
        "linux",
      ),
    ).toEqual({
      fsModuleCache: true,
      fsModuleCachePath: "/tmp/openclaw-vitest-cache",
    });
  });

  it("disables the filesystem module cache by default on Windows", () => {
    expect(loadVitestPerformanceConfig({}, "win32")).toStrictEqual({});
  });

  it("still allows enabling the filesystem module cache explicitly on Windows", () => {
    expect(
      loadVitestPerformanceConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
        },
        "win32",
      ),
    ).toEqual({
      fsModuleCache: true,
      fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
    });
  });

  it("allows disabling the filesystem module cache explicitly", () => {
    expect(
      loadVitestPerformanceConfig(
        {
          OPENCLAW_VITEST_FS_MODULE_CACHE: "0",
        },
        "linux",
      ),
    ).toStrictEqual({});
  });

  it("enables import timing output and import breakdown reporting", () => {
    expect(
      loadVitestPerformanceConfig(
        {
          OPENCLAW_VITEST_IMPORT_DURATIONS: "true",
          OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN: "1",
        },
        "linux",
      ),
    ).toEqual({
      fsModuleCache: true,
      fsModuleCachePath: path.join(process.cwd(), ".cache", "vitest", "default"),
      experimental: {
        importDurations: { print: true },
        printImportBreakdown: true,
      },
    });
  });

  it("uses RUNNER_OS to detect Windows even when the platform is not win32", () => {
    expect(loadVitestPerformanceConfig({ RUNNER_OS: "Windows" }, "linux")).toStrictEqual({});
  });
});

describe("filesystem module cache ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const cli = path.join(
    path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const runNode = (
    root: string,
    checkout: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
    expectedStatus = 0,
  ) => {
    const result = spawnSync(process.execPath, args, {
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
    });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(
      expectedStatus,
    );
    return result;
  };
  const run = (
    root: string,
    checkout: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = {},
    expectedStatus = 0,
  ) =>
    runNode(
      root,
      checkout,
      [cli, "run", "--config", path.join(checkout, "vitest.config.mjs"), ...args],
      env,
      expectedStatus,
    );
  const prepareCacheFixture = (name: string) => {
    const root = fs.realpathSync(tempDirs.make(`oc-vitest-cache-${name}-`));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: `cache-${name}`, type: "module", workspaces: [] }),
    );
    const generation = path.join(root, "dependency-generation.txt");
    const transitionLock = (version: string) => {
      // bun.lock is only a recognized hash input; no package manager is invoked.
      fs.writeFileSync(path.join(root, "bun.lock"), JSON.stringify({ version }));
      fs.writeFileSync(generation, version);
    };
    transitionLock("1.0.0");
    return { root, generation, transitionLock };
  };
  const runCacheApi = (root: string, source: string) =>
    runNode(
      root,
      root,
      createNodeEvalArgs(`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createVitest } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("vitest/node")).href)};
const root = ${JSON.stringify(root)};
const cacheConfig = ${JSON.stringify(loadVitestPerformanceConfig({}, "linux", root))};
${source}
`),
    );

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
      const cacheConfig = loadVitestPerformanceConfig({}, "linux", checkout);
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
    const firstCache = first.cacheConfig.fsModuleCachePath!;
    const sentinel = path.join(firstCache, "first-checkout-sentinel");
    fs.writeFileSync(sentinel, "owned by first checkout");
    fs.writeFileSync(lockfile, "lockfileVersion: 2\n");
    run(root, second.checkout);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned by first checkout");
  });

  it("reuses shared project transforms after a lock transition without serving a stale later project", () => {
    const { root, generation, transitionLock } = prepareCacheFixture("projects");
    // Reporter imports precede test execution and must observe the same dependency
    // generation as the selected projects after a lock transition.
    const reporterEvents = path.join(root, "reporter-events.txt");
    fs.writeFileSync(
      path.join(root, "reporter-subject.js"),
      'export const version = "__DEPENDENCY_VERSION__";\n',
    );
    fs.writeFileSync(
      path.join(root, "reporter.js"),
      `import { appendFileSync } from "node:fs";
import { version } from "./reporter-subject.js";
export default class {
  onInit() {
    appendFileSync(${JSON.stringify(reporterEvents)}, version + "\\n");
  }
}
`,
    );
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
  plugins: [{
    name: "fixture-reporter-plugin",
    transform(code, id) {
      if (id !== path.join(root, "reporter-subject.js").replaceAll("\\\\", "/")) return;
      const version = readFileSync(${JSON.stringify(generation)}, "utf8");
      appendFileSync(path.join(root, "reporter-transforms.txt"), version + "\\n");
      return { code: code.replace("__DEPENDENCY_VERSION__", version), map: null };
    },
  }],
  test: {
    reporters: ["default", path.join(root, "reporter.js")],
    fsModuleCache: aggregate.test.fsModuleCache,
    fsModuleCachePath: aggregate.test.fsModuleCachePath,
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
        fsModuleCache: scoped.test.fsModuleCache,
        fsModuleCachePath: scoped.test.fsModuleCachePath,
      },
    })),
  },
};
`,
    );
    const cacheConfig = loadVitestPerformanceConfig({}, "linux", root);
    const env = {
      OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: cacheConfig.fsModuleCachePath,
    };
    const reporterGenerations: string[] = [];
    const check = (projects: string[], expected: [number, number, number], args: string[] = []) => {
      run(root, root, [...projects.flatMap((name) => ["--project", name]), ...args], env);
      reporterGenerations.push(fs.readFileSync(generation, "utf8"));
      expect(fs.readFileSync(reporterEvents, "utf8").trimEnd().split("\n")).toEqual(
        reporterGenerations,
      );
      const counts = ["A", "B"].map(
        (name) =>
          fs.readFileSync(path.join(root, name, "transforms.txt"), "utf8").split("\n").length - 1,
      );
      counts.push(
        fs.readFileSync(path.join(root, "reporter-transforms.txt"), "utf8").split("\n").length - 1,
      );
      expect(counts, `subject transforms after selecting ${projects.join("+")}`).toEqual(expected);
    };
    check(["A", "B"], [1, 1, 1], ["--testNamePattern=(?!)"]);
    for (const name of ["A", "B"]) {
      expect(fs.readFileSync(path.join(root, name, "events.txt"), "utf8")).toBe("collect:1.0.0\n");
      expect(fs.existsSync(path.join(root, name, "body-transforms.txt"))).toBe(false);
    }
    check(["A", "B"], [1, 1, 1]);
    for (const name of ["A", "B"]) {
      expect(fs.readFileSync(path.join(root, name, "events.txt"), "utf8")).toBe(
        "collect:1.0.0\ncollect:1.0.0\nbeforeAll\nbody\n",
      );
      expect(fs.readFileSync(path.join(root, name, "body-transforms.txt"), "utf8")).toBe("1.0.0\n");
    }
    transitionLock("2.0.0");
    check(["A"], [2, 1, 2]);
    check(["A"], [2, 1, 2]);
    check(["B"], [2, 2, 2]);
    check(["B"], [2, 2, 2]);

    // Reuse must still respect ordinary source and config invalidation.
    fs.appendFileSync(path.join(root, "A", "subject.js"), "\n// source edit\n");
    check(["A", "B"], [3, 2, 2]);
    fs.writeFileSync(
      configFile,
      fs
        .readFileSync(configFile, "utf8")
        .replace(
          'const subjectFile = "subject.js";',
          'const subjectFile = "configured-subject.js";',
        ),
    );
    check(["A", "B"], [4, 3, 3]);
    check(["A", "B"], [4, 3, 3]);

    fs.appendFileSync(
      path.join(root, "A", "configured-subject.js"),
      '\nthrow new Error("fixture collection import failure");\n',
    );
    const failedCollection = run(root, root, ["--project", "A", "--testNamePattern=(?!)"], env, 1);
    expect(`${failedCollection.stdout}\n${failedCollection.stderr}`).toContain(
      "fixture collection import failure",
    );
  });

  it("imports the current lock generation through awaited configureVitest hooks", () => {
    const { root, generation } = prepareCacheFixture("hook-imports");
    runCacheApi(
      root,
      `
const generation = ${JSON.stringify(generation)};
const names = ["project-subject.js", "vitest-subject.js", "post-init.js"];
for (const name of names) {
  fs.writeFileSync(path.join(root, name), 'export const version = "__DEPENDENCY_VERSION__";');
}
let importInHook = false;
let hookValues;
const keyed = new Set();
const plugin = {
  name: "fixture-hook-imports",
  transform(code, id) {
    if (!names.some(name => id === path.join(root, name).replaceAll("\\\\", "/"))) return;
    return { code: code.replace("__DEPENDENCY_VERSION__", fs.readFileSync(generation, "utf8")), map: null };
  },
  async configureVitest({ project, vitest, defineCacheKeyGenerator }) {
    defineCacheKeyGenerator(({ id }) => {
      keyed.add(id);
      return "fixture-hook-imports";
    });
    if (importInHook) {
      const first = await project.import("./project-subject.js");
      const second = await vitest.import("./vitest-subject.js");
      hookValues = [first.version, second.version];
    }
  },
};
const create = () => createVitest("test", {
  root, config: false, watch: false, ...cacheConfig,
}, { plugins: [plugin] });
let ctx;
try {
  ctx = await create();
  assert.equal((await ctx.getRootProject().import("./project-subject.js")).version, "1.0.0");
  assert.equal((await ctx.import("./vitest-subject.js")).version, "1.0.0");
  assert.ok(fs.readdirSync(cacheConfig.fsModuleCachePath).length > 1);
  await ctx.close();
  ctx = undefined;
  fs.writeFileSync(path.join(root, "bun.lock"), JSON.stringify({ version: "2.0.0" }));
  fs.writeFileSync(generation, "2.0.0");
  importInHook = true;
  ctx = await create();
  assert.deepEqual(hookValues, ["2.0.0", "2.0.0"], "configureVitest imports must use the current generation");
  assert.equal((await ctx.import("./post-init.js")).version, "2.0.0");
  assert.ok(keyed.has(path.join(root, "post-init.js").replaceAll("\\\\", "/")));
} finally {
  await ctx?.close();
}
`,
    );
  });

  it("invalidates root and selected project cache keys together", () => {
    const { root, generation } = prepareCacheFixture("separate-projects");
    runCacheApi(
      root,
      `
const generation = ${JSON.stringify(generation)};
const projectRoot = path.join(root, "A");
fs.mkdirSync(projectRoot);
for (const directory of [root, projectRoot]) {
  fs.writeFileSync(path.join(directory, "subject.js"), 'export const version = "__DEPENDENCY_VERSION__";');
}
const plugin = {
  name: "fixture-selected-project-generation",
  transform(code, id) {
    if (!id.endsWith("/subject.js")) return;
    return { code: code.replace("__DEPENDENCY_VERSION__", fs.readFileSync(generation, "utf8")), map: null };
  },
};
const ctx = await createVitest("test", {
  root, config: false, watch: false, ...cacheConfig, project: ["A"],
  projects: [{
    extends: false,
    root: projectRoot,
    plugins: [plugin],
    test: {
      name: "A",
      fsModuleCache: true,
      fsModuleCachePath: path.join(root, "cache-A"),
    },
  }],
}, { plugins: [plugin] });
try {
  const rootProject = ctx.getRootProject();
  const selectedProject = ctx.getProjectByName("A");
  assert.equal((await rootProject.import("./subject.js")).version, "1.0.0");
  assert.equal((await selectedProject.import("./subject.js")).version, "1.0.0");
  const entries = [rootProject, selectedProject].map((project) => {
    const environment = project.runner.environment;
    const module = [...environment.moduleGraph.idToModuleMap.values()].find((entry) =>
      entry.id?.endsWith("/subject.js")
    );
    assert.ok(module?.id, JSON.stringify([...environment.moduleGraph.idToModuleMap.keys()]));
    return [environment, module.id];
  });
  for (const [environment, id] of entries) {
    assert.equal(typeof ctx._fsCache.getMemoryCachePath(environment, id), "string");
  }
  ctx.clearAllCachePaths();
  for (const [environment, id] of entries) {
    assert.equal(ctx._fsCache.getMemoryCachePath(environment, id), undefined);
  }
} finally {
  await ctx.close();
}
`,
    );
  });

  it("imports an unseen module after an awaited idle cache clear", () => {
    const { root, generation } = prepareCacheFixture("idle-clear");
    runCacheApi(
      root,
      `
const generation = ${JSON.stringify(generation)};
fs.writeFileSync(path.join(root, "first.js"), "export const value = 1;");
fs.writeFileSync(path.join(root, "next.js"), 'export const value = 2; export const version = "__DEPENDENCY_VERSION__";');
const create = () => createVitest("test", { root, config: false, watch: false, ...cacheConfig }, {
  plugins: [{
    name: "fixture-clear-generation",
    transform(code, id) {
      if (id !== path.join(root, "next.js").replaceAll("\\\\", "/")) return;
      return { code: code.replace("__DEPENDENCY_VERSION__", fs.readFileSync(generation, "utf8")), map: null };
    },
  }],
});
let ctx = await create();
try {
  assert.equal((await ctx.import("./first.js")).value, 1);
  assert.ok(fs.readdirSync(cacheConfig.fsModuleCachePath).length > 1);
  await ctx.waitForTestRunEnd();
  await ctx.clearCache();
  assert.equal(fs.existsSync(cacheConfig.fsModuleCachePath), false);
  const next = await ctx.import("./next.js");
  assert.equal(next.value, 2);
  assert.equal(next.version, "1.0.0");
  assert.ok(fs.readdirSync(cacheConfig.fsModuleCachePath).length > 0);
  await ctx.close();
  ctx = undefined;
  fs.writeFileSync(path.join(root, "bun.lock"), JSON.stringify({ version: "2.0.0" }));
  fs.writeFileSync(generation, "2.0.0");
  ctx = await create();
  const current = await ctx.import("./next.js");
  assert.equal(current.value, 2);
  assert.equal(current.version, "2.0.0", "post-clear entries must use the current generation after restart");
} finally {
  await ctx?.close();
}
`,
    );
  });
});
