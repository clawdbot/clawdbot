// Gateway run loop tests cover foreground gateway lifecycle and restart behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import {
  GATEWAY_AGENT_MEDIA_MIGRATION_REQUIRED_REASON,
  OpenClawAgentDatabaseMediaMigrationRequiredError,
} from "../../state/openclaw-agent-db-migration-required.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewayRestartIntentPayloadSync = vi.fn<
  () => { reason?: string; force?: boolean; waitMs?: number } | null
>(() => null);
const consumeGatewaySigusr1RestartIntent = vi.fn<() => GatewayRestartIntent | null>(() => null);
const managedUpdateSuccessorOwner = {
  kind: "managed-update-handoff",
  handoffId: "handoff-under-test",
  installRoot: "/openclaw/install",
} as const;
type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
const cancelManagedServiceUpdateHandoff = vi.fn<
  (_identity: ManagedUpdateOwner) => Promise<false | "restored-in-process" | "restart-after-exit">
>(async () => "restored-in-process");
const claimManagedServiceUpdateHandoff = vi.fn((_identity: ManagedUpdateOwner) => true);
const requestManagedServiceUpdateHandoffPark = vi.fn(async (_identity: ManagedUpdateOwner) => true);
const commitManagedServiceUpdateHandoff = vi.fn(
  async (_identity: ManagedUpdateOwner, _outcome?: "update" | "restore") => true,
);
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const consumeGatewayRestartIntentSync = vi.fn(() => false);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const peekGatewaySigusr1RestartReason = vi.fn<() => string | undefined>(() => undefined);
const resetGatewayRestartStateForInProcessRestart = vi.fn();
const resetGatewaySuspendCoordinatorForLifecycleRestart = vi.fn();
const rollbackGatewayRestartSignalAdmission = vi.fn();
const requestGatewayRestartWithSignalAdmission = vi.fn(() => ({ status: "emitted" as const }));
const writeGatewayRestartHandoffSync = vi.fn(
  (
    _opts: unknown,
  ): {
    kind: "gateway-supervisor-restart-handoff";
    version: 1;
    intentId: string;
    pid: number;
    createdAt: number;
    expiresAt: number;
    source: "unknown";
    restartKind: "full-process";
    supervisorMode: "external";
  } | null => ({
    kind: "gateway-supervisor-restart-handoff",
    version: 1,
    intentId: "test-intent",
    pid: process.pid,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    source: "unknown",
    restartKind: "full-process",
    supervisorMode: "external",
  }),
);
const scheduleGatewaySigusr1Restart = vi.fn((_opts?: { delayMs?: number; reason?: string }) => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR1" as const,
  delayMs: 0,
  mode: "emit" as const,
  coalesced: false,
  cooldownMsApplied: 0,
}));
const createActiveWorkSnapshot = (
  counts: Partial<GatewayActiveWorkSnapshot["counts"]> = {},
  blockers: GatewayActiveWorkSnapshot["blockers"] = [],
): GatewayActiveWorkSnapshot => {
  const resolvedCounts = {
    queueSize: 0,
    pendingReplies: 0,
    embeddedRuns: 0,
    backgroundExecSessions: 0,
    cronRuns: 0,
    activeTasks: 0,
    rootRequests: 0,
    sessionAdmissions: 0,
    sessionMutations: 0,
    chatRuns: 0,
    queuedTurns: 0,
    terminalPersistence: 0,
    terminalSessions: 0,
    totalActive: 0,
    ...counts,
  };
  resolvedCounts.totalActive = Object.entries(resolvedCounts).reduce(
    (total, [key, count]) => total + (key === "totalActive" ? 0 : count),
    0,
  );
  return { idle: resolvedCounts.totalActive === 0, counts: resolvedCounts, blockers };
};
const idleActiveWorkSnapshot = createActiveWorkSnapshot();
const createGatewayActiveWorkSnapshot = vi.fn(() => idleActiveWorkSnapshot);
const waitForGatewayActiveWork = vi.fn(
  async (
    _timeoutMs?: number,
    options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
  ) => {
    const snapshot = createGatewayActiveWorkSnapshot();
    options?.onSnapshot?.(snapshot);
    return { drained: snapshot.idle, snapshot };
  },
);
const advanceCronActiveJobGeneration = vi.fn();
const resetCronActiveJobs = vi.fn();
const abortActiveCronTaskRuns = vi.fn((_reason?: string) => 0);
const retireActiveCronTaskRunTracking = vi.fn();
const waitForActiveCronTaskRuns = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
const waitForActiveCronJobs = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
const reloadTaskRuntimeStateFromStore = vi.fn();
const clearRuntimeConfigSnapshot = vi.fn();
const restartGatewayProcessWithFreshPid = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "supervised" | "disabled" | "failed";
    detail?: string;
    handoffSpawned?: Promise<boolean>;
  }
>(() => ({ mode: "disabled" }));
const respawnGatewayProcessForUpdate = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "spawned" | "disabled" | "failed";
    pid?: number;
    detail?: string;
    child?: { kill: () => void };
  }
>(() => ({ mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" }));
const markUpdateRestartSentinelFailure = vi.fn<(reason: string) => Promise<null>>(
  async (_reason: string) => null,
);
const abortPendingChannelReloads = vi.fn();
const abortEmbeddedAgentRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting"; reason?: "restart" }) => false,
);
const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;
const gatewayLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const flushLogger = vi.fn(async () => {});
const cancelShutdownHardExitWatchdog = vi.fn();
const armShutdownHardExitWatchdog = vi.fn(
  (_params: { delayMs: number; onError: (error: unknown) => void }) => ({
    cancel: cancelShutdownHardExitWatchdog,
  }),
);

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart.js")>();
  return {
    ...actual,
    consumeGatewaySigusr1RestartIntent: () => consumeGatewaySigusr1RestartIntent(),
    consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
    isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
    markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
    peekGatewaySigusr1RestartReason: () => peekGatewaySigusr1RestartReason(),
    resetGatewayRestartStateForInProcessRestart: () =>
      resetGatewayRestartStateForInProcessRestart(),
    rollbackGatewayRestartSignalAdmission: () => rollbackGatewayRestartSignalAdmission(),
    requestGatewayRestartWithSignalAdmission,
    scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
      scheduleGatewaySigusr1Restart(opts),
  };
});

vi.mock("../../infra/restart-intent.js", () => ({
  consumeGatewayRestartIntentPayloadSync: () => consumeGatewayRestartIntentPayloadSync(),
  consumeGatewayRestartIntentSync: () => consumeGatewayRestartIntentSync(),
}));

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  cancelManagedServiceUpdateHandoff: (identity: ManagedUpdateOwner) =>
    cancelManagedServiceUpdateHandoff(identity),
  claimManagedServiceUpdateHandoff: (identity: ManagedUpdateOwner) =>
    claimManagedServiceUpdateHandoff(identity),
  requestManagedServiceUpdateHandoffPark: (identity: ManagedUpdateOwner) =>
    requestManagedServiceUpdateHandoffPark(identity),
  commitManagedServiceUpdateHandoff: (
    identity: ManagedUpdateOwner,
    outcome?: "update" | "restore",
  ) => commitManagedServiceUpdateHandoff(identity, outcome),
}));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  resetGatewaySuspendCoordinatorForLifecycleRestart: () =>
    resetGatewaySuspendCoordinatorForLifecycleRestart(),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  respawnGatewayProcessForUpdate: (opts?: { env?: NodeJS.ProcessEnv }) =>
    respawnGatewayProcessForUpdate(opts),
  restartGatewayProcessWithFreshPid: (opts?: { env?: NodeJS.ProcessEnv }) =>
    restartGatewayProcessWithFreshPid(opts),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  markUpdateRestartSentinelFailure: (reason: string) => markUpdateRestartSentinelFailure(reason),
}));

vi.mock("../../infra/restart-handoff.js", () => ({
  writeGatewayRestartHandoffSync: (opts: unknown) => writeGatewayRestartHandoffSync(opts),
}));

vi.mock("../../infra/gateway-active-work.js", () => ({
  createGatewayActiveWorkSnapshot: () => createGatewayActiveWorkSnapshot(),
  waitForGatewayActiveWork: (
    timeoutMs?: number,
    options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
  ) => waitForGatewayActiveWork(timeoutMs, options),
}));

vi.mock("../../cron/active-jobs.js", () => ({
  advanceCronActiveJobGeneration: () => advanceCronActiveJobGeneration(),
  resetCronActiveJobs: () => resetCronActiveJobs(),
  waitForActiveCronJobs: (timeoutMs: number) => waitForActiveCronJobs(timeoutMs),
}));

vi.mock("../../cron/service/active-run-cancellation.js", () => ({
  abortActiveCronTaskRuns: (reason?: string) => abortActiveCronTaskRuns(reason),
  retireActiveCronTaskRunTracking: () => retireActiveCronTaskRunTracking(),
  waitForActiveCronTaskRuns: (timeoutMs: number) => waitForActiveCronTaskRuns(timeoutMs),
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  reloadTaskRuntimeStateFromStore: () => reloadTaskRuntimeStateFromStore(),
}));

vi.mock("../../config/runtime-snapshot.js", () => ({
  clearRuntimeConfigSnapshot: () => clearRuntimeConfigSnapshot(),
  getRuntimeConfigSourceSnapshot: () => null,
  registerRuntimeConfigSnapshotPreparer: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  abortEmbeddedAgentRun: (
    sessionId?: string,
    opts?: { mode?: "all" | "compacting"; reason?: "restart" },
  ) => abortEmbeddedAgentRun(sessionId, opts),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => gatewayLog,
}));

vi.mock("../../logging/logger.js", () => ({
  flushLogger: () => flushLogger(),
}));

vi.mock("../../gateway/server-reload-contracts.js", () => ({
  abortPendingChannelReloads: () => abortPendingChannelReloads(),
}));

vi.mock("./shutdown-hard-exit.js", () => ({
  armShutdownHardExitWatchdog: (params: { delayMs: number; onError: (error: unknown) => void }) =>
    armShutdownHardExitWatchdog(params),
}));

const LOOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
type LoopSignal = (typeof LOOP_SIGNALS)[number];
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string) {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

function removeNewSignalListeners(signal: LoopSignal, existing: Set<(...args: unknown[]) => void>) {
  for (const listener of process.listeners(signal)) {
    const fn = listener as (...args: unknown[]) => void;
    if (!existing.has(fn)) {
      process.removeListener(signal, fn);
    }
  }
}

function addedSignalListener(
  signal: LoopSignal,
  existing: Set<(...args: unknown[]) => void>,
): (() => void) | null {
  const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
  for (let i = listeners.length - 1; i >= 0; i -= 1) {
    const listener = listeners[i];
    if (listener && !existing.has(listener)) {
      return listener as () => void;
    }
  }
  return null;
}

async function withIsolatedSignals(
  run: (helpers: { captureSignal: (signal: LoopSignal) => () => void }) => Promise<void>,
) {
  const existingListeners = Object.fromEntries(
    LOOP_SIGNALS.map((signal) => [
      signal,
      new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>),
    ]),
  ) as Record<LoopSignal, Set<(...args: unknown[]) => void>>;
  const captureSignal = (signal: LoopSignal) => {
    const listener = addedSignalListener(signal, existingListeners[signal]);
    if (!listener) {
      throw new Error(`expected new ${signal} listener`);
    }
    return () => listener();
  };
  try {
    await run({ captureSignal });
  } finally {
    for (const signal of LOOP_SIGNALS) {
      removeNewSignalListeners(signal, existingListeners[signal]);
    }
  }
}

function createRuntimeWithExitSignal(exitCallOrder?: string[]) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      exitCallOrder?.push("exit");
      resolveExit(code);
    }),
  };
  return { runtime, exited };
}

type GatewayCloseFn = GatewayServer["close"];
type LoopRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

function createCloseMock() {
  return vi.fn<GatewayCloseFn>(async (_opts) => {});
}

function createGatewayServer(close: GatewayCloseFn, startupSettled = Promise.resolve()) {
  return {
    getTailscaleIngressEndpoint: () => undefined,
    close,
    startupSettled,
  } satisfies GatewayServer;
}

function expectRestartCloseCall(
  close: ReturnType<typeof createCloseMock>,
  maxDrainTimeoutMs: number,
) {
  expect(close).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "gateway restarting",
      restartExpectedMs: 1500,
      drainTimeoutMs: expect.any(Number),
    }),
  );
  const closeArgs = close.mock.calls[0]?.[0];
  expect(closeArgs?.drainTimeoutMs).toBeLessThanOrEqual(maxDrainTimeoutMs);
  expect(closeArgs?.drainTimeoutMs).toBeGreaterThanOrEqual(0);
}

function createSignaledStart(close: GatewayCloseFn, startupSettled = Promise.resolve()) {
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn(async () => {
    resolveStarted?.();
    return createGatewayServer(close, startupSettled);
  });
  return { start, started };
}

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: LoopRuntime;
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  healthHost?: string;
  waitForHealthyChild?: (port: number, pid?: number, host?: string) => Promise<boolean>;
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    ownsProcessLifecycle: params.ownsProcessLifecycle,
    lockPort: params.lockPort,
    healthHost: params.healthHost,
    waitForHealthyChild: params.waitForHealthyChild,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function waitForLoopCondition(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(message);
}

async function createSignaledLoopHarness(exitCallOrder?: string[]) {
  const close = createCloseMock();
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

function expectRestartHandoffCall(expected: {
  restartKind: "full-process" | "update-process";
  reason: string | undefined;
  supervisorMode: "external" | "launchd";
}) {
  expect(writeGatewayRestartHandoffSync).toHaveBeenCalledTimes(1);
  const [handoff] = writeGatewayRestartHandoffSync.mock.calls[0] ?? [];
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    throw new Error("expected restart handoff options object");
  }
  const processInstanceId = (handoff as { processInstanceId?: unknown }).processInstanceId;
  expect(typeof processInstanceId).toBe("string");
  if (typeof processInstanceId !== "string") {
    throw new Error("expected restart handoff processInstanceId string");
  }
  expect(processInstanceId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(handoff).toEqual({
    ...expected,
    processInstanceId,
  });
}

let gatewayWorkAdmissionActual: typeof import("../../process/gateway-work-admission.js");
let supervisorEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

beforeEach(async () => {
  vi.useRealTimers();
  supervisorEnvSnapshot = captureEnv([...SUPERVISOR_HINT_ENV_VARS]);
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }

  // clearAllMocks preserves queued one-shot results. A skipped lifecycle branch
  // must not shift a stale supervisor or respawn decision into the next case.
  consumeGatewaySigusr1RestartIntent.mockReset();
  consumeGatewaySigusr1RestartIntent.mockReturnValue(null);
  peekGatewaySigusr1RestartReason.mockReset();
  peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
  restartGatewayProcessWithFreshPid.mockReset();
  restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "disabled" });
  respawnGatewayProcessForUpdate.mockReset();
  respawnGatewayProcessForUpdate.mockReturnValue({
    mode: "disabled",
    detail: "OPENCLAW_NO_RESPAWN",
  });

  gatewayWorkAdmissionActual = await vi.importActual("../../process/gateway-work-admission.js");
  gatewayWorkAdmissionActual.resetGatewayWorkAdmission();
  createGatewayActiveWorkSnapshot.mockReset();
  createGatewayActiveWorkSnapshot.mockReturnValue(idleActiveWorkSnapshot);
  waitForGatewayActiveWork.mockReset();
  waitForGatewayActiveWork.mockImplementation(async (_timeoutMs, options) => {
    const snapshot = createGatewayActiveWorkSnapshot();
    options?.onSnapshot?.(snapshot);
    return { drained: snapshot.idle, snapshot };
  });
  cancelManagedServiceUpdateHandoff.mockReset();
  cancelManagedServiceUpdateHandoff.mockResolvedValue("restored-in-process");
  claimManagedServiceUpdateHandoff.mockReset();
  claimManagedServiceUpdateHandoff.mockReturnValue(true);
  requestManagedServiceUpdateHandoffPark.mockReset();
  requestManagedServiceUpdateHandoffPark.mockResolvedValue(true);
  commitManagedServiceUpdateHandoff.mockReset();
  commitManagedServiceUpdateHandoff.mockResolvedValue(true);
});

afterEach(() => {
  supervisorEnvSnapshot?.restore();
  supervisorEnvSnapshot = undefined;
  vi.useRealTimers();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("runGatewayLoop", () => {
  it("routes deferred startup failure through first-boot failure handling", async () => {
    await withIsolatedSignals(async () => {
      const startupError = new Error("deferred startup failed");
      const close = createCloseMock();
      let rejectStartup: (error: Error) => void = () => {};
      const startupSettled = new Promise<void>((_resolve, reject) => {
        rejectStartup = reject;
      });
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.js");
      const start = vi.fn(async () => {
        markStarted();
        return createGatewayServer(close, startupSettled);
      });
      const loop = runGatewayLoop({
        start,
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        completeBoot,
      });

      await started;
      rejectStartup(startupError);

      await expect(loop).rejects.toBe(startupError);
      expect(close).toHaveBeenCalledWith({ reason: "gateway startup failed" });
      expect(completeBoot).toHaveBeenCalledWith({
        outcome: "startup_failed",
        reason: startupError.message,
      });
    });
  });

  it("keeps running when deferred startup fails after a SIGUSR1 replacement", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const unresolvedFirstStartup = new Promise<void>(() => {});
      const replacementError = new Error("replacement deferred startup failed");
      const cleanupError = new Error("replacement cleanup failed");
      const closeFirst = createCloseMock();
      const closeSecond = vi.fn<GatewayCloseFn>(async () => {
        throw cleanupError;
      });
      const closeThird = createCloseMock();
      let markThirdStarted: (() => void) | undefined;
      const thirdStarted = new Promise<void>((resolve) => {
        markThirdStarted = resolve;
      });
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(closeFirst, unresolvedFirstStartup))
        .mockImplementationOnce(async () =>
          createGatewayServer(closeSecond, Promise.reject(replacementError)),
        )
        .mockImplementationOnce(async () => {
          markThirdStarted?.();
          return createGatewayServer(closeThird);
        });
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await waitForLoopCondition(
        () => start.mock.calls.length === 1,
        "expected first deferred startup server",
      );
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await waitForLoopCondition(
        () =>
          gatewayLog.error.mock.calls.some(([message]) =>
            String(message).includes(replacementError.message),
          ),
        "expected replacement deferred startup failure",
      );
      expect(closeSecond).toHaveBeenCalledWith({ reason: "gateway startup failed" });
      expect(gatewayLog.warn).toHaveBeenCalledWith(expect.stringContaining(cleanupError.message));

      sigusr1();
      await thirdStarted;
      expect(start).toHaveBeenCalledTimes(3);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("keeps truncated startup failure reasons free of lone surrogates", async () => {
    await withIsolatedSignals(async () => {
      const failure = `${"a".repeat(499)}😀tail`;
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.js");
      await expect(
        runGatewayLoop({
          start: vi.fn(async () => {
            throw new Error(failure);
          }) as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
          completeBoot,
        }),
      ).rejects.toThrow(failure);

      const reason =
        (completeBoot.mock.calls[0]?.[0] as { reason?: string } | undefined)?.reason ?? "";
      expect(reason).toHaveLength(499);
      expect(Buffer.from(reason).toString()).toBe(reason);
    });
  });

  it("records a typed reason for media-migration startup failures", async () => {
    await withIsolatedSignals(async () => {
      const failure = new OpenClawAgentDatabaseMediaMigrationRequiredError(
        "/tmp/openclaw-agent.sqlite",
        14,
      );
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.js");

      await expect(
        runGatewayLoop({
          start: vi.fn(async () => {
            throw failure;
          }) as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
          completeBoot,
        }),
      ).rejects.toBe(failure);

      expect(completeBoot).toHaveBeenCalledWith({
        outcome: "startup_failed",
        reason: failure.message,
        startupReason: GATEWAY_AGENT_MEDIA_MIGRATION_REQUIRED_REASON,
      });
    });
  });

  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      flushLogger.mockImplementationOnce(async () => {
        expect(runtime.exit).not.toHaveBeenCalled();
      });

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(start).toHaveBeenCalledWith({
        startupStartedAt: expect.any(Number),
        requestHotReloadRecovery: requestGatewayRestartWithSignalAdmission,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expect(flushLogger).toHaveBeenCalledOnce();
      expect(armShutdownHardExitWatchdog).not.toHaveBeenCalled();
    });
  });

  it("names and canonically formats a gateway close failure", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn<GatewayCloseFn>(async () => {
        throw new TypeError("close owner failed");
      });
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime });
      await waitForStart(started);

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "shutdown step failed (gateway server close): close owner failed",
      );
    });
  });

  it("completes SIGTERM shutdown while sidecar startup remains unresolved", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const unresolvedSidecarStartup = new Promise<void>(() => {});
      const close = vi.fn<GatewayCloseFn>(async () => {});
      const { start, started } = createSignaledStart(close, unresolvedSidecarStartup);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime });
      await waitForStart(started);

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "drains rootless embedded work before closing on direct %s stop",
    async (signal) => {
      vi.clearAllMocks();

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited } = await createSignaledLoopHarness();
        let releaseDrain: (() => void) | undefined;
        const pendingDrain = new Promise<void>((resolve) => {
          releaseDrain = resolve;
        });
        const activeSnapshot = createActiveWorkSnapshot({ embeddedRuns: 1 }, [
          { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
        ]);
        waitForGatewayActiveWork.mockImplementationOnce(async (_timeoutMs, options) => {
          options?.onSnapshot?.(activeSnapshot);
          await pendingDrain;
          return { drained: true, snapshot: idleActiveWorkSnapshot };
        });

        try {
          captureSignal(signal)();
          await waitForLoopCondition(
            () => waitForGatewayActiveWork.mock.calls.length === 1,
            `expected ${signal} to drain canonical active work`,
          );

          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, undefined);
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();

          releaseDrain?.();

          await expect(exited).resolves.toBe(0);
          expect(close).toHaveBeenCalledWith({
            reason: "gateway stopping",
            restartExpectedMs: null,
          });
        } finally {
          releaseDrain?.();
          await exited;
        }
      });
    },
  );

  it("continues direct shutdown when the bounded active-work drain times out", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const timedOutSnapshot = createActiveWorkSnapshot({ embeddedRuns: 2 }, [
        { kind: "embedded-run", count: 2, message: "2 active embedded run(s)" },
      ]);
      waitForGatewayActiveWork.mockResolvedValueOnce({
        drained: false,
        snapshot: timedOutSnapshot,
      });
      const { close, runtime, exited } = await createSignaledLoopHarness();

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, undefined);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "gateway active-work drain timeout reached; proceeding with shutdown: 2 active embedded run(s)",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("still closes and exits when the direct-shutdown active-work drain fails", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      waitForGatewayActiveWork.mockRejectedValueOnce(new Error("active-work drain unavailable"));
      const { close, runtime, exited } = await createSignaledLoopHarness();

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, undefined);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "gateway active-work drain failed; proceeding with shutdown: active-work drain unavailable",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("does not start a second active-work drain for repeated shutdown signals", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { exited } = await createSignaledLoopHarness();
      let releaseDrain: (() => void) | undefined;
      const pendingDrain = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        await pendingDrain;
        return { drained: true, snapshot: idleActiveWorkSnapshot };
      });

      try {
        const sigterm = captureSignal("SIGTERM");
        const sigint = captureSignal("SIGINT");
        sigterm();
        await waitForLoopCondition(
          () => waitForGatewayActiveWork.mock.calls.length === 1,
          "expected first shutdown signal to begin the active-work drain",
        );

        sigint();

        expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        expect(gatewayLog.info).toHaveBeenCalledWith("received SIGINT during shutdown; ignoring");

        releaseDrain?.();
        await expect(exited).resolves.toBe(0);
      } finally {
        releaseDrain?.();
        await exited;
      }
    });
  });

  it("bounds the file-log flush before a graceful SIGTERM exit", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      flushLogger.mockReturnValueOnce(new Promise<void>(() => {}));
      vi.useFakeTimers();
      try {
        sigterm();
        await vi.advanceTimersByTimeAsync(4_000);

        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "log flush did not settle within 4000ms; continuing shutdown",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("treats SIGTERM with a restart intent as a draining restart", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({});
    createGatewayActiveWorkSnapshot
      .mockReturnValueOnce(
        createActiveWorkSnapshot({ activeTasks: 1 }, [
          { kind: "task", count: 1, message: "1 active background task run(s)" },
        ]),
      )
      .mockReturnValue(idleActiveWorkSnapshot);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      let resolveSecond: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(closeFirst))
        .mockImplementationOnce(async () => {
          resolveSecond?.();
          return createGatewayServer(closeSecond);
        });
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      sigint();
      await expect(exited).resolves.toBe(0);
      expect(closeSecond).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it("uses restart intent wait overrides for SIGTERM drain", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 2_500 });
    createGatewayActiveWorkSnapshot
      .mockReturnValueOnce(
        createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
          { kind: "task", count: 1, message: "1 active background task run(s)" },
          { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
        ]),
      )
      .mockReturnValue(idleActiveWorkSnapshot);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(2_500);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("caps reply drain time for unbounded SIGTERM restarts", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 0 });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expectRestartCloseCall(close, 315_000);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("waits for the drain before handing recovery ownership to server close", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 0 });
    const drainStart = createActiveWorkSnapshot({ embeddedRuns: 2 }, [
      { kind: "embedded-run", count: 2, message: "2 active embedded run(s)" },
    ]);
    let releaseDrain: (() => void) | undefined;
    const pendingDrain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(drainStart);
    waitForGatewayActiveWork.mockImplementationOnce(async () => {
      // Recovery ownership must be collected later by server close, after this
      // window lets active work settle.
      await pendingDrain;
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await vi.waitFor(() => expect(waitForGatewayActiveWork).toHaveBeenCalledOnce());

      expect(abortEmbeddedAgentRun).toHaveBeenCalledWith(undefined, {
        mode: "compacting",
        reason: "restart",
      });
      expect(close).not.toHaveBeenCalled();

      releaseDrain?.();
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));

      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(undefined, expect.any(Object));
      expectRestartCloseCall(close, 315_000);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("hands timed-out active work to server close", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({});
    const timedOutSnapshot = createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
      { kind: "task", count: 1, message: "1 active background task run(s)" },
      { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
    ]);
    createGatewayActiveWorkSnapshot.mockReturnValue(timedOutSnapshot);
    waitForGatewayActiveWork.mockResolvedValueOnce({
      drained: false,
      snapshot: timedOutSnapshot,
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "active-work drain timeout reached; proceeding with restart: 1 active background task run(s); 1 active embedded run(s)",
      );
      expectRestartCloseCall(close, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("skips a second active-work drain after a SIGUSR1 deferral timeout intent", async () => {
    vi.clearAllMocks();
    consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
      force: true,
      reason: "config reload forced restart",
    });
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
        { kind: "task", count: 1, message: "1 active background task run(s)" },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigint = captureSignal("SIGINT");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).not.toHaveBeenCalled();
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledOnce();
      expectRestartCloseCall(close, 0);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("forces SIGTERM restarts without waiting for active task drain", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ force: true });
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
        {
          kind: "task",
          count: 1,
          message: "taskId=task-force runId=run-force status=running runtime=cron label=forced",
        },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).not.toHaveBeenCalled();
      expect(gatewayLog.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "taskId=task-force runId=run-force status=running runtime=cron label=forced",
        ),
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "forced restart requested; skipping active work drain",
      );
      expectRestartCloseCall(close, 0);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("restarts after SIGUSR1 even when drain times out, and resets runtime state for the new iteration", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });
    markUpdateRestartSentinelFailure.mockClear();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const timedOutSnapshot = createActiveWorkSnapshot({ activeTasks: 2, embeddedRuns: 1 }, [
        { kind: "task", count: 2, message: "2 active background task run(s)" },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]);
      createGatewayActiveWorkSnapshot
        .mockReturnValueOnce(timedOutSnapshot)
        .mockReturnValue(idleActiveWorkSnapshot);
      waitForGatewayActiveWork.mockResolvedValueOnce({
        drained: false,
        snapshot: timedOutSnapshot,
      });

      type StartServer = () => Promise<{
        close: GatewayCloseFn;
      }>;

      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      const lifecycleSlot = resolveGlobalMap<string, number>(
        Symbol("run-loop-lifecycle-slot"),
        (state) => state.clear(),
      );
      const agentEventsActual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      const firstAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();

      const start = vi.fn<StartServer>();
      let resolveFirst: (() => void) | null = null;
      const startedFirst = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveFirst?.();
        return createGatewayServer(closeFirst);
      });

      let resolveSecond: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        resolveSecond?.();
        return createGatewayServer(closeSecond);
      });

      let resolveThird: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });
      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        resolveThird?.();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await startedFirst;
      lifecycleSlot.set("first", 1);
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      sigusr1();

      await startedSecond;
      const secondAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
      expect(secondAgentEventGeneration).not.toBe(firstAgentEventGeneration);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "active-work drain timeout reached; proceeding with restart: 2 active background task run(s); 1 active embedded run(s)",
      );
      expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway restarting.");
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledWith(1_000);
      expect(waitForActiveCronJobs).toHaveBeenCalledWith(1_000);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(1);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(1);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(1);
      expect(clearRuntimeConfigSnapshot).toHaveBeenCalledTimes(1);
      expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(1);
      expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(1);
      expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(1);
      expect(reloadTaskRuntimeStateFromStore.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        start.mock.invocationCallOrder[1] ?? Infinity,
      );
      expect(advanceCronActiveJobGeneration.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        abortActiveCronTaskRuns.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(waitForActiveCronJobs.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        resetCronActiveJobs.mock.invocationCallOrder[0] ?? Infinity,
      );

      lifecycleSlot.set("second", 2);
      sigusr1();

      await startedThird;
      const thirdAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
      expect(thirdAgentEventGeneration).not.toBe(secondAgentEventGeneration);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expectRestartCloseCall(closeSecond, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
      expect(abortActiveCronTaskRuns).toHaveBeenCalledTimes(2);
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledTimes(2);
      expect(waitForActiveCronJobs).toHaveBeenCalledTimes(2);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(2);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(2);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(2);
      expect(clearRuntimeConfigSnapshot).toHaveBeenCalledTimes(2);
      expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
      expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
      expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it("advances stale cron active markers after bounded restart cron-run drain", async () => {
    vi.clearAllMocks();
    waitForActiveCronJobs.mockResolvedValueOnce({ drained: false, active: 1 });
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigint = captureSignal("SIGINT");

      sigusr1();
      await waitForLoopCondition(
        () => start.mock.calls.length >= 2,
        "expected SIGUSR1 to trigger restart",
      );

      expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway restarting.");
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledWith(1_000);
      expect(waitForActiveCronJobs).toHaveBeenCalledWith(1_000);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(1);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(1);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "cron run drain timed out during restart lifecycle reset after retiring old cron admission; 0 task handle(s) and 1 active marker(s) remain after aborting old cron runs",
      );

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("queues SIGUSR1 received before the run-loop installs its restart waiter", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      let releaseFirstStart!: () => void;
      const firstStartMayReturn = new Promise<void>((resolve) => {
        releaseFirstStart = resolve;
      });
      let sigusr1: (() => void) | null = null;
      let resolveSecondStart: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecondStart = resolve;
      });
      const start = vi.fn();
      start.mockImplementationOnce(async () => {
        await firstStartMayReturn;
        sigusr1?.();
        await waitForLoopCondition(
          () => markGatewaySigusr1RestartHandled.mock.calls.length > 0,
          "expected SIGUSR1 handler to consume the restart before startup returned",
        );
        await waitForLoopCondition(
          () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
          "expected queued startup restart to mark gateway draining before startup returned",
        );
        return createGatewayServer(closeFirst);
      });
      start.mockImplementationOnce(async () => {
        resolveSecondStart?.();
        return createGatewayServer(closeSecond);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      try {
        releaseFirstStart();

        await waitForLoopCondition(
          () => start.mock.calls.length >= 2,
          "expected queued SIGUSR1 to trigger the second gateway start",
        );
        await startedSecond;
        expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
        expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(1);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(1);
        expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(1);
      } finally {
        sigterm();
        await expect(exited).resolves.toBe(0);
      }
    });
  });

  it("exits if a queued startup restart never reaches a close handle", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    vi.useFakeTimers();

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const startupNeverReturns = new Promise<void>(() => {});
        let markStartupEntered: () => void = () => {};
        const startupEntered = new Promise<void>((resolve) => {
          markStartupEntered = resolve;
        });
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const start = vi.fn(async () => {
          markStartupEntered();
          await startupNeverReturns;
          return createGatewayServer(close);
        });

        const { runGatewayLoop } = await import("./run-loop.js");
        void runGatewayLoop({
          start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
          completeBoot,
        });
        await vi.advanceTimersByTimeAsync(0);
        await startupEntered;
        const sigusr1 = captureSignal("SIGUSR1");

        sigusr1();
        await vi.advanceTimersByTimeAsync(0);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(324_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(exited).resolves.toBe(1);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "forced_stop",
          reason: "gateway.restart_startup_request_timeout",
        });
        expect(close).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(1);
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes SIGINT immediately before startup returns a server", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const startupNeverReturns = new Promise<void>(() => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const start = vi.fn(async () => {
        await startupNeverReturns;
        return createGatewayServer(close);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigint = captureSignal("SIGINT");

      sigint();

      await expect(exited).resolves.toBe(0);
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(1);
    });
  });

  it("lets SIGINT override a queued startup restart before startup returns a server", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const startupNeverReturns = new Promise<void>(() => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const start = vi.fn(async () => {
        await startupNeverReturns;
        return createGatewayServer(close);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigusr1 = captureSignal("SIGUSR1");
      const sigint = captureSignal("SIGINT");

      sigusr1();
      await waitForLoopCondition(
        () => markGatewaySigusr1RestartHandled.mock.calls.length > 0,
        "expected startup SIGUSR1 to be queued",
      );

      sigint();

      await expect(exited).resolves.toBe(0);
      expect(close).not.toHaveBeenCalled();
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(1);
      expect(gatewayLog.info).toHaveBeenCalledWith(
        "received SIGINT; overriding pending startup restart with shutdown",
      );
    });
  });

  it("processes queued SIGUSR1 when restart startup fails before returning a server", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      let sigusr1: (() => void) | null = null;
      let resolveThirdStart: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThirdStart = resolve;
      });
      const start = vi.fn();
      start.mockResolvedValueOnce(createGatewayServer(closeFirst));
      start.mockImplementationOnce(async () => {
        sigusr1?.();
        await waitForLoopCondition(
          () => markGatewaySigusr1RestartHandled.mock.calls.length >= 2,
          "expected SIGUSR1 during failed startup to be accepted before startup throws",
        );
        throw new Error("restart startup failed");
      });
      start.mockImplementationOnce(async () => {
        resolveThirdStart?.();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      try {
        sigusr1();

        await waitForLoopCondition(
          () => start.mock.calls.length >= 3,
          "expected queued SIGUSR1 to advance past failed restart startup",
        );
        await startedThird;
        expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
        expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
        expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
        expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
        expect(gatewayLog.error).toHaveBeenCalledWith(
          expect.stringContaining("gateway startup failed: restart startup failed."),
        );
      } finally {
        sigterm();
        await expect(exited).resolves.toBe(0);
      }
    });
  });

  it("processes SIGUSR1 received after restart startup fails before returning a server", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      let resolveThirdStart: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThirdStart = resolve;
      });
      const start = vi.fn();
      start.mockResolvedValueOnce(createGatewayServer(closeFirst));
      start.mockRejectedValueOnce(new Error("restart startup failed"));
      start.mockImplementationOnce(async () => {
        resolveThirdStart?.();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      try {
        sigusr1();
        await waitForLoopCondition(
          () =>
            gatewayLog.error.mock.calls.some(([message]) =>
              String(message).includes("gateway startup failed: restart startup failed."),
            ),
          "expected failed restart startup to be logged",
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(start).toHaveBeenCalledTimes(2);

        sigusr1();
        await waitForLoopCondition(
          () => start.mock.calls.length >= 3,
          "expected post-failure SIGUSR1 to retry gateway startup",
        );
        await startedThird;
        expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
        expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
        expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
        expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
      } finally {
        sigterm();
        await expect(exited).resolves.toBe(0);
      }
    });
  });

  it("keeps the process alive and retries after task runtime state restores fail", async () => {
    vi.clearAllMocks();
    reloadTaskRuntimeStateFromStore.mockReset();
    reloadTaskRuntimeStateFromStore
      .mockImplementationOnce(() => {
        throw new Error("task-flow registry restore failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("task registry restore failed");
      });
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const closeFirst = createCloseMock();
        const closeSecond = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        let resolveSecondStart: (() => void) | null = null;
        const startedSecond = new Promise<void>((resolve) => {
          resolveSecondStart = resolve;
        });
        const start = vi
          .fn()
          .mockResolvedValueOnce(createGatewayServer(closeFirst))
          .mockImplementationOnce(async () => {
            resolveSecondStart?.();
            return createGatewayServer(closeSecond);
          });

        const { runGatewayLoop } = await import("./run-loop.js");
        void runGatewayLoop({
          start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        });
        await waitForLoopCondition(
          () => start.mock.calls.length === 1,
          "expected initial gateway start",
        );
        const sigusr1 = captureSignal("SIGUSR1");
        const sigterm = captureSignal("SIGTERM");

        try {
          sigusr1();
          await waitForLoopCondition(
            () =>
              gatewayLog.error.mock.calls.some(([message]) =>
                String(message).includes(
                  "gateway startup failed: task-flow registry restore failed.",
                ),
              ),
            "expected failed task-flow registry restore to be logged",
          );

          expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
          expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(1);
          expect(start).toHaveBeenCalledTimes(1);
          expect(runtime.exit).not.toHaveBeenCalled();

          sigusr1();
          await waitForLoopCondition(
            () =>
              gatewayLog.error.mock.calls.some(([message]) =>
                String(message).includes("gateway startup failed: task registry restore failed."),
              ),
            "expected failed task-registry restore to be logged",
          );

          expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
          expect(start).toHaveBeenCalledTimes(1);
          expect(runtime.exit).not.toHaveBeenCalled();

          sigusr1();
          await startedSecond;

          expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(3);
          expect(start).toHaveBeenCalledTimes(2);
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          sigterm();
          await expect(exited).resolves.toBe(0);
        }

        expect(closeSecond).toHaveBeenCalledWith({
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
      });
    } finally {
      reloadTaskRuntimeStateFromStore.mockReset();
    }
  });

  it("uses the built-in restart drain timeout", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      createGatewayActiveWorkSnapshot
        .mockReturnValueOnce(
          createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
            { kind: "task", count: 1, message: "1 active background task run(s)" },
            { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
          ]),
        )
        .mockReturnValue(idleActiveWorkSnapshot);

      const { start } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  it("clears stale restart state before routing external SIGUSR1 through the scheduler", async () => {
    vi.clearAllMocks();
    consumeGatewaySigusr1RestartAuthorization.mockReturnValueOnce(false);
    isGatewaySigusr1RestartExternallyAllowed.mockReturnValueOnce(true);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
        delayMs: 0,
        reason: "SIGUSR1",
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(markGatewaySigusr1RestartHandled.mock.invocationCallOrder[0]).toBeLessThan(
        scheduleGatewaySigusr1Restart.mock.invocationCallOrder[0] ?? 0,
      );
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  it("clears the in-flight restart token when an unauthorized SIGUSR1 is ignored", async () => {
    vi.clearAllMocks();
    consumeGatewaySigusr1RestartAuthorization.mockReturnValueOnce(false);
    isGatewaySigusr1RestartExternallyAllowed.mockReturnValueOnce(false);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "SIGUSR1 restart ignored (not authorized; commands.restart=false).",
      );
      expect(gatewayLog.warn).toHaveBeenCalledTimes(2);
      expect(gatewayLog.warn).toHaveBeenNthCalledWith(
        2,
        "An unauthorized SIGUSR1 restart signal was received and ignored. " +
          "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
          "or restart the gateway through your service manager.",
      );
    });
  });

  it("clears the in-flight restart token when a file intent handles authorized SIGUSR1", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({
      force: true,
      reason: "file-intent restart",
    });
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ embeddedRuns: 1 }, [
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigint = captureSignal("SIGINT");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(consumeGatewaySigusr1RestartAuthorization).toHaveBeenCalledOnce();
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("calls abortPendingChannelReloads for file-intent restart even when authorization is false", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({
      force: true,
      reason: "file-intent restart",
    });
    consumeGatewaySigusr1RestartAuthorization.mockReturnValueOnce(false);
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ embeddedRuns: 1 }, [
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigint = captureSignal("SIGINT");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      // File-intent restart always restarts regardless of authorization.
      // abortPendingChannelReloads must be called to cancel any stale
      // deferred channel reload work before the in-process restart.
      expect(abortPendingChannelReloads).toHaveBeenCalledOnce();
      // Authorization was consumed but returned false.
      expect(consumeGatewaySigusr1RestartAuthorization).toHaveBeenCalledOnce();
      // markGatewaySigusr1RestartHandled should NOT be called when auth is false.
      expect(markGatewaySigusr1RestartHandled).not.toHaveBeenCalled();
      // Restart still proceeds for file-intent regardless of auth result.
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("releases the lock before exiting on supervised restart", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    const originalTraceEnv = process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const lockRelease = vi.fn(async () => {});
        acquireGatewayLock.mockResolvedValueOnce({
          release: lockRelease,
        });

        restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });

        const exitCallOrder: string[] = [];
        const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
        const sigusr1 = captureSignal("SIGUSR1");
        lockRelease.mockImplementation(async () => {
          exitCallOrder.push("lockRelease");
        });

        sigusr1();

        await exited;
        expect(lockRelease).toHaveBeenCalledTimes(1);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
        const [respawnOpts] = restartGatewayProcessWithFreshPid.mock.calls[0] ?? [];
        expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS).toMatch(/^\d/u);
        expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS).toMatch(/^\d/u);
        expect(writeGatewayRestartHandoffSync).toHaveBeenCalledOnce();
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      if (originalTraceEnv === undefined) {
        delete process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
      } else {
        process.env.OPENCLAW_GATEWAY_RESTART_TRACE = originalTraceEnv;
      }
    }
  });

  it("waits briefly before exiting on launchd supervised restart", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(true),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");

        vi.useFakeTimers();
        sigusr1();
        await vi.advanceTimersByTimeAsync(1499);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expectRestartHandoffCall({
          restartKind: "full-process",
          reason: undefined,
          supervisorMode: "launchd",
        });
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("falls back in-process when the launchd restart handoff fails to spawn", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(false),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        vi.useFakeTimers();
        sigusr1();
        await vi.advanceTimersByTimeAsync(1500);

        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "launchd restart handoff failed to spawn; falling back to in-process restart",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("carries SIGTERM restart intent reason into launchd supervised handoff", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "gateway.restart" });
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(true),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { exited } = await createSignaledLoopHarness();
        const sigterm = captureSignal("SIGTERM");

        vi.useFakeTimers();
        sigterm();
        await vi.advanceTimersByTimeAsync(1500);

        await expect(exited).resolves.toBe(0);
        expectRestartHandoffCall({
          restartKind: "full-process",
          reason: "gateway.restart",
          supervisorMode: "launchd",
        });
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("records external ownership even when native supervisor markers are inherited", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");

        sigusr1();

        await expect(exited).resolves.toBe(0);
        expectRestartHandoffCall({
          restartKind: "full-process",
          reason: undefined,
          supervisorMode: "external",
        });
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
    }
  });

  it("falls back in-process when an external restart handoff cannot be persisted", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });
    writeGatewayRestartHandoffSync.mockReturnValueOnce(null);

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        sigusr1();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "external handoff failure did not restart in-process",
        );

        expect(runtime.exit).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "external supervisor restart handoff could not be persisted; falling back to in-process restart",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("forwards lockPort to initial and restart lock acquisitions", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(closeFirst))
        .mockResolvedValueOnce(createGatewayServer(closeSecond))
        .mockResolvedValueOnce(createGatewayServer(closeThird));
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        lockPort: 18789,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      sigusr1();

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(1, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(2, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(3, { port: 18789 });

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(new Error("lock timeout"));

      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      sigusr1();

      await expect(exited).resolves.toBe(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "failed to reacquire gateway lock for in-process restart: Error: lock timeout",
      );
    });
  });

  it("hard-respawns update restarts and exits only after the replacement becomes healthy", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 7777,
      child: { kill: vi.fn() },
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const waitForHealthyChild = vi.fn(async () => true);
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime, lockPort: 18789, waitForHealthyChild });
      await waitForStart(started);
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();

      await expect(exited).resolves.toBe(0);
      expect(waitForHealthyChild).toHaveBeenCalledWith(18789, 7777, "127.0.0.1");
      expect(respawnGatewayProcessForUpdate).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
      expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
    });
  });

  it.each(["update.run", "update.auto"] as const)(
    "writes a handoff before exiting for supervised %s restarts",
    async (reason) => {
      vi.clearAllMocks();
      peekGatewaySigusr1RestartReason.mockReturnValue(reason);
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
      });
      try {
        setPlatform("freebsd");
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { runtime, exited } = await createSignaledLoopHarness();
          const sigusr1 = captureSignal("SIGUSR1");

          sigusr1();

          await expect(exited).resolves.toBe(0);
          expect(runtime.exit).toHaveBeenCalledWith(0);
          expectRestartHandoffCall({
            restartKind: "update-process",
            reason,
            supervisorMode: "external",
          });
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        });
      } finally {
        delete process.env.OPENCLAW_SUPERVISOR_MODE;
        if (originalPlatformDescriptor) {
          Object.defineProperty(process, "platform", originalPlatformDescriptor);
        }
      }
    },
  );

  it("falls back in-process when a launchd update handoff fails to spawn", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(false),
    });
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        vi.useFakeTimers();
        sigusr1();
        await vi.advanceTimersByTimeAsync(1500);

        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("keeps running when an external update restart handoff cannot be persisted", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });
    writeGatewayRestartHandoffSync.mockReturnValueOnce(null);

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        sigusr1();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "external update handoff failure did not restart in-process",
        );

        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("upgrades an accepted restart when an update arrives during shutdown", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason
      .mockReturnValueOnce("config.patch")
      .mockReturnValueOnce("update.auto");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });

    let releaseClose: () => void = () => {};
    const close = vi.fn<GatewayCloseFn>(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    setPlatform("freebsd");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime, ownsProcessLifecycle: true });
        await waitForStart(started);
        const sigusr1 = captureSignal("SIGUSR1");

        sigusr1();
        await waitForLoopCondition(
          () => close.mock.calls.length === 1,
          "restart close did not start",
        );
        sigusr1();
        await waitForLoopCondition(
          () =>
            gatewayLog.info.mock.calls.some(([message]) =>
              String(message).includes("upgrading to update.auto"),
            ),
          "accepted restart was not upgraded",
        );

        releaseClose();
        await expect(exited).resolves.toBe(0);
        expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
        expectRestartHandoffCall({
          restartKind: "update-process",
          reason: "update.auto",
          supervisorMode: "external",
        });
      });
    } finally {
      releaseClose();
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("reads an update upgrade after asynchronous lock release", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason
      .mockReturnValueOnce("config.patch")
      .mockReturnValueOnce("update.auto");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });

    let releaseLock: () => void = () => {};
    const lockReleaseBlocked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockRelease = vi.fn(async () => {
      await lockReleaseBlocked;
    });
    acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        sigusr1();
        await waitForLoopCondition(
          () => lockRelease.mock.calls.length === 1,
          "restart did not reach lock release",
        );
        sigusr1();
        await waitForLoopCondition(
          () =>
            gatewayLog.info.mock.calls.some(([message]) =>
              String(message).includes("upgrading to update.auto"),
            ),
          "lock-release restart was not upgraded",
        );

        releaseLock();
        await expect(exited).resolves.toBe(0);
        expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
        expect(runtime.exit).toHaveBeenCalledWith(0);
      });
    } finally {
      releaseLock();
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("recovers in process after exactly cancelling a replacement managed owner before exit", async () => {
    vi.clearAllMocks();
    const replacementOwner = { ...managedUpdateSuccessorOwner, handoffId: "replacement-handoff" };
    consumeGatewaySigusr1RestartIntent
      .mockReturnValueOnce({ reason: "update.run", successorOwner: managedUpdateSuccessorOwner })
      .mockReturnValueOnce({ reason: "update.auto", successorOwner: replacementOwner });
    cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restored-in-process")
      .mockResolvedValueOnce("restored-in-process");

    let releaseCommit: () => void = () => {};
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    commitManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
      await commitBlocked;
      return true;
    });
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");
        sigusr1();
        await waitForLoopCondition(
          () => commitManagedServiceUpdateHandoff.mock.calls.length === 1,
          "managed owner did not reach its final helper commit",
        );
        sigusr1();
        await waitForLoopCondition(
          () => consumeGatewaySigusr1RestartIntent.mock.calls.length === 2,
          "replacement owner was not admitted before exit",
        );
        releaseCommit();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "replacement managed owner cancellation did not reopen gateway admission",
        );

        expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(
          1,
          managedUpdateSuccessorOwner,
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(2, replacementOwner);
        expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
          "update",
        );
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      releaseCommit();
      delete process.env.OPENCLAW_SERVICE_MARKER;
      delete process.env.OPENCLAW_SERVICE_KIND;
    }
  });

  it("reopens admission after a broken control pipe waits for the exact helper to exit", async () => {
    vi.clearAllMocks();
    consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    requestManagedServiceUpdateHandoffPark.mockResolvedValueOnce(false);
    let releaseHelperExit: () => void = () => {};
    const helperExit = new Promise<void>((resolve) => {
      releaseHelperExit = resolve;
    });
    cancelManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
      await helperExit;
      return "restored-in-process";
    });
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        sigusr1();
        await waitForLoopCondition(
          () => cancelManagedServiceUpdateHandoff.mock.calls.length === 1,
          "broken helper control pipe did not begin exact-owner cancellation",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        releaseHelperExit();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "broken helper control pipe left the gateway permanently draining",
        );

        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      releaseHelperExit();
      delete process.env.OPENCLAW_SERVICE_MARKER;
      delete process.env.OPENCLAW_SERVICE_KIND;
    }
  });

  it("probes the configured gateway host for update respawn health", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 7778,
      child: { kill: vi.fn() },
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const waitForHealthyChild = vi.fn(async () => true);
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({
        start,
        runtime,
        lockPort: 18789,
        healthHost: "10.0.0.25",
        waitForHealthyChild,
      });
      await waitForStart(started);
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();

      await expect(exited).resolves.toBe(0);
      expect(waitForHealthyChild).toHaveBeenCalledWith(18789, 7778, "10.0.0.25");
    });
  });

  it("marks update respawn failures and falls back to in-process restart", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    const kill = vi.fn();
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 8888,
      child: { kill },
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const waitForHealthyChild = vi.fn(async () => false);
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(closeFirst))
        .mockResolvedValueOnce(createGatewayServer(closeSecond));

      await runLoopWithStart({ start, runtime, lockPort: 18789, waitForHealthyChild });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForHealthyChild).toHaveBeenCalledWith(18789, 8888, "127.0.0.1");
      expect(kill).toHaveBeenCalledTimes(1);
      expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith("restart-unhealthy");
      expect(start).toHaveBeenCalledTimes(2);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("catches SIGTERM handler errors, logs them, and falls back to stop (#83131)", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("dynamic import failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "failed to handle SIGTERM: Error: dynamic import failed",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("catches SIGUSR1 handler errors even when token cleanup throws (#83131)", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("lifecycle module corrupted");
    });
    markGatewaySigusr1RestartHandled.mockImplementationOnce(() => {
      throw new Error("recovery import also failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(gatewayLog.error).toHaveBeenCalledWith(
        "SIGUSR1 handler failed: lifecycle module corrupted",
      );
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalled();
      expect(rollbackGatewayRestartSignalAdmission).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("catches SIGUSR1 handler errors, clears restart token, and does not crash (#83131)", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("sigusr1 lifecycle import failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      // The catch handler clears the restart token from the eagerly-loaded
      // lifecycle runtime, so wait for the async signal body to reject.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(gatewayLog.error).toHaveBeenCalledWith(
        "SIGUSR1 handler failed: sigusr1 lifecycle import failed",
      );
      // Restart token must be cleared so future SIGUSR1 restarts are not
      // permanently coalesced as "already in-flight".
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalled();
      expect(rollbackGatewayRestartSignalAdmission).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("recloses restart admission after a failed SIGUSR1 handler rolls it back", async () => {
    vi.clearAllMocks();
    markGatewaySigusr1RestartHandled.mockImplementationOnce(() => {
      throw new Error("restart token cleanup failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await waitForLoopCondition(
        () => rollbackGatewayRestartSignalAdmission.mock.calls.length === 1,
        "failed SIGUSR1 handler did not roll back restart admission",
      );

      sigusr1();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "second SIGUSR1 did not start a restart",
      );

      expect(close).toHaveBeenCalledTimes(1);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });
});

describe("gateway discover routing helpers", () => {
  it("prefers resolved service host over TXT hints", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      port: 18789,
      lanHost: "evil.example.com",
      tailnetDns: "evil.example.com",
    };
    expect(pickBeaconHost(beacon)).toBe("10.0.0.2");
  });

  it("prefers resolved service port over TXT gatewayPort", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      port: 18789,
      gatewayPort: 12345,
    };
    expect(pickGatewayPort(beacon)).toBe(18789);
  });

  it("fails closed when resolve data is missing", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      lanHost: "test-host.local",
      gatewayPort: 18789,
    };
    expect(pickBeaconHost(beacon)).toBeNull();
    expect(pickGatewayPort(beacon)).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
