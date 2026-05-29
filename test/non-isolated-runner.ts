import fs from "node:fs";
import path from "node:path";
import { TestRunner, type RunnerTask, type RunnerTestSuite, vi } from "vitest";

type EvaluatedModuleNode = {
  promise?: unknown;
  exports?: unknown;
  evaluated?: boolean;
  importers: Set<string>;
};

type EvaluatedModules = {
  idToModuleMap: Map<string, EvaluatedModuleNode>;
};

const SHARED_TEST_SETUP = Symbol.for("openclaw.sharedTestSetup");

function getSharedTestHome(): string | undefined {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_TEST_SETUP]?: { tempHome?: string };
  };
  return globalState[SHARED_TEST_SETUP]?.tempHome ?? process.env.OPENCLAW_TEST_HOME;
}

function resetEvaluatedModules(modules: EvaluatedModules, resetMocks: boolean) {
  const skipPaths = [
    /\/vitest\/dist\//,
    /vitest-virtual-\w+\/dist/u,
    /@vitest\/dist/u,
    ...(resetMocks ? [] : [/^mock:/u]),
  ];

  modules.idToModuleMap.forEach((node, modulePath) => {
    if (skipPaths.some((pattern) => pattern.test(modulePath))) {
      return;
    }
    node.promise = undefined;
    node.exports = undefined;
    node.evaluated = false;
    node.importers.clear();
  });
}

function restoreSharedTestHomeAfterEnvUnstub(testHomeRaw: string | undefined): void {
  const testHome = testHomeRaw?.trim();
  if (!testHome) {
    return;
  }

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.OPENCLAW_TEST_HOME = testHome;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = path.join(testHome, ".config");
  process.env.XDG_DATA_HOME = path.join(testHome, ".local", "share");
  process.env.XDG_STATE_HOME = path.join(testHome, ".local", "state");
  process.env.XDG_CACHE_HOME = path.join(testHome, ".cache");
}

function restoreRealTimers(): void {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
}

export default class OpenClawNonIsolatedRunner extends TestRunner {
  override onCollectStart(file: { filepath: string }) {
    super.onCollectStart(file);
    restoreRealTimers();
    restoreSharedTestHomeAfterEnvUnstub(getSharedTestHome());
    const orderLogPath = process.env.OPENCLAW_VITEST_FILE_ORDER_LOG?.trim();
    if (orderLogPath) {
      fs.appendFileSync(orderLogPath, `START ${file.filepath}\n`);
    }
  }

  override async onBeforeRunTask(test: RunnerTask) {
    restoreRealTimers();
    await super.onBeforeRunTask(test);
  }

  override onBeforeTryTask(test: RunnerTask) {
    restoreRealTimers();
    super.onBeforeTryTask(test);
  }

  override async onAfterRunSuite(suite: RunnerTestSuite) {
    await super.onAfterRunSuite(suite);
    if (this.config.isolate || !("filepath" in suite) || typeof suite.filepath !== "string") {
      return;
    }

    const orderLogPath = process.env.OPENCLAW_VITEST_FILE_ORDER_LOG?.trim();
    if (orderLogPath) {
      fs.appendFileSync(orderLogPath, `END ${suite.filepath}\n`);
    }

    // Mirror the missing cleanup from Vitest isolate mode so shared workers do
    // not carry file-scoped timers, stubs, spies, or stale module state
    // forward into the next file.
    restoreRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const testHome = getSharedTestHome();
    vi.unstubAllEnvs();
    restoreSharedTestHomeAfterEnvUnstub(testHome);
    vi.clearAllMocks();
    vi.resetModules();
    this.moduleRunner?.mocker?.reset?.();
    resetEvaluatedModules(this.workerState.evaluatedModules as EvaluatedModules, true);
  }
}
