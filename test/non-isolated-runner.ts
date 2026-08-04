// Non-isolated runner helps execute tests without Vitest isolation.
import fs from "node:fs";
import path from "node:path";
import { TestRunner, type RunnerTask, type RunnerTestFile, vi } from "vitest";
import { clearNamedPluginRuntimeStoresForTest } from "../src/plugin-sdk/runtime-store-registry.js";

type EvaluatedModuleNode = {
  promise?: unknown;
  exports?: unknown;
  evaluated?: boolean;
  importers: Set<string>;
};

type EvaluatedModules = {
  idToModuleMap: Map<string, EvaluatedModuleNode>;
};

type SerializableMocker = {
  reset?: () => void;
  resolveMocks?: () => Promise<void>;
};

type TestRunnerInternals = {
  moduleRunner?: { mocker?: SerializableMocker };
  workerState: { evaluatedModules: unknown };
};

const SHARED_TEST_SETUP = Symbol.for("openclaw.sharedTestSetup");
const EMBEDDED_RUN_STATE = Symbol.for("openclaw.embeddedRunState");
const REPLY_RUN_REGISTRY = Symbol.for("openclaw.replyRunRegistry");
const DIAGNOSTIC_EVENTS_STATE = Symbol.for("openclaw.diagnosticEvents.state.v1");
const DIAGNOSTIC_EVENT_LISTENER_PRESENCE = Symbol.for(
  "openclaw.diagnosticEventListenerPresence.v1",
);
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
  // The listener-presence mirror is a separate globalThis record; clearing the
  // sets above without zeroing it leaves hasInternalDiagnosticEventListeners()
  // true for the next file (e.g. an import-time registration like
  // diagnostic-run-activity.ts whose stop handle died with the module registry).
  const presence = globalStore[DIAGNOSTIC_EVENT_LISTENER_PRESENCE] as
    | { internalCount?: number; trustedCount?: number }
    | undefined;
  if (presence) {
    presence.internalCount = 0;
    presence.trustedCount = 0;
  }
}

const SERIALIZED_RESOLVE_MOCKS = Symbol.for("openclaw.serializedResolveMocks");

// Vitest's BareModuleMocker.resolveMocks has no in-flight guard: pendingIds is
// cleared only after all parallel resolveId RPCs settle, and every registration
// re-invalidates the mock module node. In a shared isolate:false worker, stray
// async work from an earlier file (a leaked timer running a dynamic import) can
// start a second concurrent pass over the same pendingIds while the next file's
// vi.mock registrations resolve. The slower pass then re-registers and wipes
// already-evaluated manual mock modules mid-import-chain, so importers before
// the wipe hold one factory instance and later importers get a fresh one
// (vi.mocked(...) on the test's binding silently stops reaching prod).
//
// The pin chains each caller onto its own sequential pass instead of sharing
// one in-flight pass. Two invariants both matter:
// - Serialization: a pass queued behind an in-flight one sees the cleared
//   queue and no-ops, so a snapshot is never registered (and its mock modules
//   never invalidated) twice.
// - Freshness: every caller's pass starts at or after its call, so ids the
//   caller queued (vi.mock/doMock/doUnmock before a dynamic import) are
//   registered before its fetch proceeds. Sharing one pass breaks this — a
//   caller can coalesce onto a pass snapshotted before its ids were queued and
//   then import with mock state unresolved (observed: auth-provenance's
//   doUnmock + Promise.all imports loading the real provider-auth warm worker
//   and a 120s oauth refresh instead of the mocked provider hook).
export function serializeMockerResolveMocks(
  mocker: SerializableMocker & { [SERIALIZED_RESOLVE_MOCKS]?: boolean },
): void {
  if (!mocker.resolveMocks || mocker[SERIALIZED_RESOLVE_MOCKS]) {
    return;
  }
  mocker[SERIALIZED_RESOLVE_MOCKS] = true;
  const original = mocker.resolveMocks.bind(mocker);
  const statics = mocker.constructor as { pendingIds?: unknown[] };
  const runPass = async (): Promise<void> => {
    const queue = statics.pendingIds;
    const processedCount = queue?.length ?? 0;
    await original();
    // Upstream snapshots the queue contents at pass start and reassigns the
    // pendingIds static to [] at the end, so ids queued during the pass's RPC
    // window land in the abandoned array. Requeue them so the next chained
    // pass registers them instead of silently dropping the registration.
    if (queue && queue !== statics.pendingIds && queue.length > processedCount) {
      statics.pendingIds?.push(...queue.slice(processedCount));
    }
  };
  let tail: Promise<void> = Promise.resolve();
  mocker.resolveMocks = () => {
    const pass = tail.then(runPass);
    // Keep the chain alive after a rejected pass; the rejection still reaches
    // the caller that owns that pass, matching upstream behavior.
    tail = pass.then(
      () => undefined,
      () => undefined,
    );
    return pass;
  };
}

export default class OpenClawNonIsolatedRunner extends TestRunner {
  override onCollectStart(file: RunnerTestFile) {
    super.onCollectStart(file);
    const internals = this as unknown as TestRunnerInternals;
    if (internals.moduleRunner?.mocker) {
      serializeMockerResolveMocks(internals.moduleRunner.mocker);
    }
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

  // Cross-file cleanup lives in onAfterRunFiles, not onAfterRunSuite: vitest
  // early-returns runSuite for files that failed during collection (and for
  // skipped file suites) without firing onAfterRunSuite, which used to leave
  // the crashed file's evaluated real modules cached in the shared worker so
  // the next file's vi.mock factories silently never applied. The worker loop
  // calls startTests per file, so this hook runs after every file regardless
  // of its collect/run outcome.
  override onAfterRunFiles(files?: RunnerTestFile[]) {
    super.onAfterRunFiles();
    if (this.config.isolate) {
      return;
    }

    const orderLogPath = process.env.OPENCLAW_VITEST_FILE_ORDER_LOG?.trim();
    if (orderLogPath) {
      for (const file of files ?? []) {
        fs.appendFileSync(orderLogPath, `END ${file.filepath}\n`);
      }
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
    // Named plugin runtimes intentionally survive duplicate module evaluation in production.
    // Clear their shared slots here so one test file cannot lend a partial runtime to the next.
    clearNamedPluginRuntimeStoresForTest();
    vi.resetModules();
    const internals = this as unknown as TestRunnerInternals;
    internals.moduleRunner?.mocker?.reset?.();
    resetEvaluatedModules(internals.workerState.evaluatedModules as EvaluatedModules, true);
  }
}
