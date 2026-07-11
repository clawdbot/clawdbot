// Non-isolated runner helps execute tests without Vitest isolation.
import fs from "node:fs";
import path from "node:path";
import { TestRunner, type RunnerTask, type RunnerTestFile, type RunnerTestSuite, vi } from "vitest";

type EvaluatedModuleNode = {
  promise?: unknown;
  exports?: unknown;
  evaluated?: boolean;
  importers: Set<string>;
};

type EvaluatedModules = {
  idToModuleMap: Map<string, EvaluatedModuleNode>;
};

type TestRunnerInternals = {
  moduleRunner?: { mocker?: { reset?: () => void } };
  workerState: { evaluatedModules: unknown };
};

const SHARED_TEST_SETUP = Symbol.for("openclaw.sharedTestSetup");
const EMBEDDED_RUN_STATE = Symbol.for("openclaw.embeddedRunState");
const REPLY_RUN_REGISTRY = Symbol.for("openclaw.replyRunRegistry");
const DIAGNOSTIC_EVENTS_STATE = Symbol.for("openclaw.diagnosticEvents.state.v1");
const nativeTimerGlobals = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  Date: globalThis.Date,
};

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

function restoreNativeTimerGlobals(): void {
  Object.assign(globalThis, nativeTimerGlobals);
}

function restoreMocksThenRealTimers(): void {
  // A spy created while fake timers are active captures the fake timer as its
  // "original" implementation. Restore spies first, then swap timers back.
  vi.restoreAllMocks();
  restoreRealTimers();
  restoreNativeTimerGlobals();
}

type CleanupAction = () => void;

type EmbeddedRunHandle = {
  abort?: () => void;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
};

type EmbeddedRunWaiter = {
  timer?: NodeJS.Timeout;
  resolve?: (ended: boolean) => void;
};

type EmbeddedRunStateForTest = {
  activeRuns?: Map<unknown, EmbeddedRunHandle>;
  snapshots?: Map<unknown, unknown>;
  sessionIdsByKey?: Map<unknown, unknown>;
  sessionIdsByFile?: Map<unknown, unknown>;
  abandonedRunsBySessionId?: Map<unknown, unknown>;
  abandonedRunSessionIdsByKey?: Map<unknown, unknown>;
  abandonedRunSessionIdsByFile?: Map<unknown, unknown>;
  waiters?: Map<unknown, Set<EmbeddedRunWaiter>>;
  modelSwitchRequests?: Map<unknown, unknown>;
};

type ReplyRunWaiter = {
  finish?: (ended: boolean) => void;
};

type ReplyRunOperation = {
  abortForRestart?: () => void;
};

type ReplyRunStateForTest = {
  activeRunsByKey?: Map<unknown, ReplyRunOperation>;
  activeSessionIdsByKey?: Map<unknown, unknown>;
  activeKeysBySessionId?: Map<unknown, unknown>;
  waitKeysBySessionId?: Map<unknown, unknown>;
  waitersByKey?: Map<unknown, Set<ReplyRunWaiter>>;
};

type DiagnosticEventsStateForTest = {
  listeners?: Set<unknown>;
  trustedListeners?: Set<unknown>;
  toolExecutionListeners?: Set<unknown>;
  asyncQueue?: unknown[];
};

function runCleanupActions(actions: CleanupAction[]): unknown {
  let firstError: unknown;
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

function resetOpenClawGlobalRunState(): void {
  const cleanupActions: CleanupAction[] = [];
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const embeddedRunState = globalStore[EMBEDDED_RUN_STATE] as EmbeddedRunStateForTest | undefined;
  for (const handle of embeddedRunState?.activeRuns?.values() ?? []) {
    cleanupActions.push(() => {
      if (handle.cancel) {
        handle.cancel("restart");
        return;
      }
      handle.abort?.();
    });
  }
  for (const waiters of embeddedRunState?.waiters?.values() ?? []) {
    for (const waiter of waiters) {
      cleanupActions.push(() => {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve?.(true);
      });
    }
  }

  const replyRunState = globalStore[REPLY_RUN_REGISTRY] as ReplyRunStateForTest | undefined;
  for (const operation of replyRunState?.activeRunsByKey?.values() ?? []) {
    cleanupActions.push(() => {
      operation.abortForRestart?.();
    });
  }
  for (const waiters of replyRunState?.waitersByKey?.values() ?? []) {
    for (const waiter of waiters) {
      cleanupActions.push(() => {
        waiter.finish?.(false);
      });
    }
  }

  const cleanupError = runCleanupActions(cleanupActions);
  if (cleanupError) {
    // oxlint-disable-next-line typescript/only-throw-error -- cleanup hooks may throw their original non-Error value; preserve that test-runner behavior.
    throw cleanupError;
  }

  embeddedRunState?.activeRuns?.clear();
  embeddedRunState?.snapshots?.clear();
  embeddedRunState?.sessionIdsByKey?.clear();
  embeddedRunState?.sessionIdsByFile?.clear();
  embeddedRunState?.abandonedRunsBySessionId?.clear();
  embeddedRunState?.abandonedRunSessionIdsByKey?.clear();
  embeddedRunState?.abandonedRunSessionIdsByFile?.clear();
  embeddedRunState?.waiters?.clear();
  embeddedRunState?.modelSwitchRequests?.clear();

  replyRunState?.activeRunsByKey?.clear();
  replyRunState?.activeSessionIdsByKey?.clear();
  replyRunState?.activeKeysBySessionId?.clear();
  replyRunState?.waitKeysBySessionId?.clear();
  replyRunState?.waitersByKey?.clear();
}

function resetOpenClawGlobalDiagnosticState(): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = globalStore[DIAGNOSTIC_EVENTS_STATE] as DiagnosticEventsStateForTest | undefined;
  // The dispatcher intentionally survives module reloads. Mirror isolate mode
  // without duplicating its private state defaults in the test runner.
  state?.listeners?.clear();
  state?.trustedListeners?.clear();
  state?.toolExecutionListeners?.clear();
  state?.asyncQueue?.splice(0);
  Reflect.deleteProperty(globalStore, DIAGNOSTIC_EVENTS_STATE);
}

export default class OpenClawNonIsolatedRunner extends TestRunner {
  override onCollectStart(file: RunnerTestFile) {
    super.onCollectStart(file);
    restoreRealTimers();
    restoreNativeTimerGlobals();
    restoreSharedTestHomeAfterEnvUnstub(getSharedTestHome());
    const orderLogPath = process.env.OPENCLAW_VITEST_FILE_ORDER_LOG?.trim();
    if (orderLogPath) {
      fs.appendFileSync(orderLogPath, `START ${file.filepath}\n`);
    }
  }

  override async onBeforeRunTask(test: RunnerTask) {
    restoreRealTimers();
    restoreNativeTimerGlobals();
    await super.onBeforeRunTask(test);
  }

  override onBeforeTryTask(test: RunnerTask) {
    restoreRealTimers();
    restoreNativeTimerGlobals();
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
    restoreMocksThenRealTimers();
    vi.unstubAllGlobals();
    const testHome = getSharedTestHome();
    vi.unstubAllEnvs();
    restoreSharedTestHomeAfterEnvUnstub(testHome);
    vi.clearAllMocks();
    resetOpenClawGlobalRunState();
    resetOpenClawGlobalDiagnosticState();
    vi.resetModules();
    const internals = this as unknown as TestRunnerInternals;
    internals.moduleRunner?.mocker?.reset?.();
    resetEvaluatedModules(internals.workerState.evaluatedModules as EvaluatedModules, true);
  }
}
