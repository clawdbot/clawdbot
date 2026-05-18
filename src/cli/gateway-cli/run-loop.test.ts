import { describe, expect, it, vi } from "vitest";
import type { GatewayServer } from "../../gateway/server.impl.js";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewayRestartIntentPayloadSync = vi.fn<
  () => { reason?: string; force?: boolean; waitMs?: number } | null
>(() => null);
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const consumeGatewayRestartIntentSync = vi.fn(() => false);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const peekGatewaySigusr1RestartReason = vi.fn<() => string | undefined>(() => undefined);
const resetGatewayRestartStateForInProcessRestart = vi.fn();
const writeGatewayRestartHandoffSync = vi.fn((_opts: unknown) => ({
  kind: "gateway-supervisor-restart-handoff" as const,
  version: 1 as const,
  intentId: "test-intent",
  pid: process.pid,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  source: "unknown" as const,
  restartKind: "full-process" as const,
  supervisorMode: "external" as const,
}));
const scheduleGatewaySigusr1Restart = vi.fn((_opts?: { delayMs?: number; reason?: string }) => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR1" as const,
  delayMs: 0,
  mode: "emit" as const,
  coalesced: false,
  cooldownMsApplied: 0,
}));
const getActiveTaskCount = vi.fn(() => 0);
const getInspectableActiveTaskRestartBlockers = vi.fn(
  () =>
    [] as Array<{
      taskId: string;
      status: "queued" | "running";
      runtime: "subagent" | "acp" | "cli" | "cron";
      runId?: string;
      label?: string;
      title?: string;
    }>,
);
const markGatewayDraining = vi.fn();
const waitForActiveTasks = vi.fn(async (_timeoutMs?: number) => ({ drained: true }));
const resetAllLanes = vi.fn();
const reloadTaskRegistryFromStore = vi.fn();
const restartGatewayProcessWithFreshPid = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "spawned" | "supervised" | "disabled" | "failed";
    pid?: number;
    detail?: string;
  }
>(() => ({ mode: "disabled" }));
const respawnGatewayProcessForUpdate = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "spawned" | "supervised" | "disabled" | "failed";
    pid?: number;
    detail?: string;
    child?: { kill: () => void };
  }
>(() => ({ mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" }));
const markUpdateRestartSentinelFailure = vi.fn<(reason: string) => Promise<null>>(
  async (_reason: string) => null,
);
const abortEmbeddedPiRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting" }) => false,
);
const getActiveEmbeddedRunCount = vi.fn(() => 0);
const listActiveEmbeddedRunSessionIds = vi.fn(() => [] as string[]);
const listActiveEmbeddedRunSessionKeys = vi.fn(() => [] as string[]);
const markRestartAbortedMainSessions = vi.fn(async (_params: unknown) => ({
  marked: 1,
  skipped: 0,
}));
const waitForActiveEmbeddedRuns = vi.fn(async (_timeoutMs?: number) => ({ drained: true }));
const DRAIN_TIMEOUT_LOG = "drain timeout reached; proceeding with restart";
const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;
const loadConfig = vi.fn<() => { gateway: { reload: { deferralTimeoutMs?: number } } }>(() => ({
  gateway: {
    reload: {
      deferralTimeoutMs: 90_000,
    },
  },
}));
const gatewayLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", () => ({
  consumeGatewayRestartIntentPayloadSync: () => consumeGatewayRestartIntentPayloadSync(),
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  consumeGatewayRestartIntentSync: () => consumeGatewayRestartIntentSync(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
  peekGatewaySigusr1RestartReason: () => peekGatewaySigusr1RestartReason(),
  resetGatewayRestartStateForInProcessRestart: () => resetGatewayRestartStateForInProcessRestart(),
  resolveGatewayRestartDeferralTimeoutMs: (timeoutMs: unknown) => {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      return DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS;
    }
    if (timeoutMs <= 0) {
      return undefined;
    }
    return Math.floor(timeoutMs);
  },
  scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
    scheduleGatewaySigusr1Restart(opts),
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

vi.mock("../../process/command-queue.js", () => ({
  getActiveTaskCount: () => getActiveTaskCount(),
  markGatewayDraining: () => markGatewayDraining(),
  waitForActiveTasks: (timeoutMs?: number) => waitForActiveTasks(timeoutMs),
  resetAllLanes: () => resetAllLanes(),
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  reloadTaskRegistryFromStore: () => reloadTaskRegistryFromStore(),
}));

vi.mock("../../tasks/task-registry.maintenance.js", () => ({
  getInspectableActiveTaskRestartBlockers: () => getInspectableActiveTaskRestartBlockers(),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (sessionId?: string, opts?: { mode?: "all" | "compacting" }) =>
    abortEmbeddedPiRun(sessionId, opts),
  getActiveEmbeddedRunCount: () => getActiveEmbeddedRunCount(),
  listActiveEmbeddedRunSessionIds: () => listActiveEmbeddedRunSessionIds(),
  listActiveEmbeddedRunSessionKeys: () => listActiveEmbeddedRunSessionKeys(),
  waitForActiveEmbeddedRuns: (timeoutMs?: number) => waitForActiveEmbeddedRuns(timeoutMs),
}));

vi.mock("../../agents/main-session-restart-recovery.js", () => ({
  markRestartAbortedMainSessions: (params: unknown) => markRestartAbortedMainSessions(params),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => gatewayLog,
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

function createSignaledStart(close: GatewayCloseFn) {
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn(async () => {
    resolveStarted?.();
    return { close };
  });
  return { start, started };
}

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: LoopRuntime;
  lockPort?: number;
  healthHost?: string;
  waitForHealthyChild?: (port: number, pid?: number, host?: string) => Promise<boolean>;
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    lockPort: params.lockPort,
    healthHost: params.healthHost,
    waitForHealthyChild: params.waitForHealthyChild,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForLoopCondition(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
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

describe("runGatewayLoop", () => {
  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("treats SIGTERM with a restart intent as a draining restart", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({});
    getActiveTaskCount.mockReturnValueOnce(1).mockReturnValue(0);

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
        .mockResolvedValueOnce({ close: closeFirst })
        .mockImplementationOnce(async () => {
          resolveSecond?.();
          return { close: closeSecond };
        });
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledOnce();
      expect(markGatewayDraining).toHaveBeenCalledOnce();
      expect(waitForActiveTasks).toHaveBeenCalledWith(90_000);
      expectRestartCloseCall(closeFirst, 90_000);
      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));

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
    getActiveTaskCount.mockReturnValueOnce(1).mockReturnValue(0);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForActiveTasks).toHaveBeenCalledWith(2_500);
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
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expectRestartCloseCall(close, 15_000);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("aborts active embedded runs after a short restart drain grace", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({});
    getActiveTaskCount.mockReturnValueOnce(1).mockReturnValue(0);
    getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValue(0);
    listActiveEmbeddedRunSessionIds.mockReturnValueOnce(["session-embedded-timeout"]);
    listActiveEmbeddedRunSessionKeys.mockReturnValueOnce(["agent:main:embedded-timeout"]);
    waitForActiveTasks.mockResolvedValueOnce({ drained: false });
    waitForActiveEmbeddedRuns.mockResolvedValueOnce({ drained: false });
    markRestartAbortedMainSessions.mockRejectedValueOnce(new Error("store read-only"));

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForActiveTasks).toHaveBeenCalledWith(90_000);
      expect(waitForActiveEmbeddedRuns).toHaveBeenCalledWith(30_000);
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "compacting" });
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "all" });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "active embedded run drain grace reached; aborting active run(s) before restart",
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(DRAIN_TIMEOUT_LOG);
      expect(markRestartAbortedMainSessions).toHaveBeenCalledWith({
        cfg: {
          gateway: {
            reload: {
              deferralTimeoutMs: 90_000,
            },
          },
        },
        sessionIds: new Set(["session-embedded-timeout"]),
        sessionKeys: new Set(["agent:main:embedded-timeout"]),
        reason: "gateway restart drain timeout",
      });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "failed to mark interrupted main sessions for restart recovery: Error: store read-only",
      );
      expectRestartCloseCall(close, 90_000);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("forces SIGTERM restarts without waiting for active task drain", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ force: true });
    getActiveTaskCount.mockReturnValueOnce(1).mockReturnValue(0);
    getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValue(0);
    listActiveEmbeddedRunSessionIds.mockReturnValueOnce(["session-forced-task"]);
    listActiveEmbeddedRunSessionKeys.mockReturnValueOnce(["agent:main:forced-task"]);
    const forceTaskBlockers = [
      {
        taskId: "task-force",
        runId: "run-force",
        status: "running" as const,
        runtime: "cron" as const,
        label: "forced",
      },
    ];
    getInspectableActiveTaskRestartBlockers
      .mockReturnValueOnce(forceTaskBlockers)
      .mockReturnValueOnce(forceTaskBlockers)
      .mockReturnValueOnce(forceTaskBlockers);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");
      const sigint = captureSignal("SIGINT");

      sigterm();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForActiveTasks).not.toHaveBeenCalled();
      expect(waitForActiveEmbeddedRuns).not.toHaveBeenCalled();
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "all" });
      expect(markRestartAbortedMainSessions).toHaveBeenCalledWith({
        cfg: {
          gateway: {
            reload: {
              deferralTimeoutMs: 90_000,
            },
          },
        },
        sessionIds: new Set(["session-forced-task"]),
        sessionKeys: new Set(["agent:main:forced-task"]),
        reason: "forced gateway restart",
      });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "restart blocked by active background task run(s): taskId=task-force runId=run-force status=running runtime=cron label=forced",
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "forced restart requested; skipping active work drain",
      );
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("restarts after SIGUSR1 even when drain times out, and resets runtime state for the new iteration", async () => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({
      gateway: {
        reload: {
          deferralTimeoutMs: 1_234,
        },
      },
    });
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });
    markUpdateRestartSentinelFailure.mockClear();

    await withIsolatedSignals(async ({ captureSignal }) => {
      getActiveTaskCount.mockReturnValueOnce(2).mockReturnValueOnce(0);
      getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValueOnce(0);
      listActiveEmbeddedRunSessionIds.mockReturnValueOnce(["session-issue-82433"]);
      listActiveEmbeddedRunSessionKeys.mockReturnValueOnce(["agent:main:issue-82433"]);
      waitForActiveTasks.mockResolvedValueOnce({ drained: false });
      waitForActiveEmbeddedRuns.mockResolvedValueOnce({ drained: true });

      type StartServer = () => Promise<{
        close: GatewayCloseFn;
      }>;

      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi.fn<StartServer>();
      let resolveFirst: (() => void) | null = null;
      const startedFirst = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveFirst?.();
        return { close: closeFirst };
      });

      let resolveSecond: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveSecond?.();
        return { close: closeSecond };
      });

      let resolveThird: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveThird?.();
        return { close: closeThird };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await startedFirst;
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      sigusr1();

      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "compacting" });
      expect(waitForActiveTasks).toHaveBeenCalledWith(1_234);
      expect(waitForActiveEmbeddedRuns).toHaveBeenCalledWith(1_234);
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "all" });
      expect(markRestartAbortedMainSessions).toHaveBeenCalledWith({
        cfg: {
          gateway: {
            reload: {
              deferralTimeoutMs: 1_234,
            },
          },
        },
        sessionIds: new Set(["session-issue-82433"]),
        sessionKeys: new Set(["agent:main:issue-82433"]),
        reason: "gateway restart drain timeout",
      });
      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(DRAIN_TIMEOUT_LOG);
      expectRestartCloseCall(closeFirst, 1_234);
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(resetAllLanes).toHaveBeenCalledTimes(1);
      expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(1);
      expect(reloadTaskRegistryFromStore).toHaveBeenCalledTimes(1);

      sigusr1();

      await startedThird;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expectRestartCloseCall(closeSecond, 1_234);
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
      expect(markGatewayDraining).toHaveBeenCalledTimes(2);
      expect(resetAllLanes).toHaveBeenCalledTimes(2);
      expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
      expect(reloadTaskRegistryFromStore).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
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
          () => markGatewayDraining.mock.calls.length > 0,
          "expected queued startup restart to mark gateway draining before startup returned",
        );
        return { close: closeFirst };
      });
      start.mockImplementationOnce(async () => {
        resolveSecondStart?.();
        return { close: closeSecond };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      try {
        releaseFirstStart();

        await waitForLoopCondition(
          () => start.mock.calls.length >= 2,
          "expected queued SIGUSR1 to trigger the second gateway start",
        );
        await startedSecond;
        expectRestartCloseCall(closeFirst, 90_000);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
        expect(markGatewayDraining).toHaveBeenCalledTimes(1);
        expect(resetAllLanes).toHaveBeenCalledTimes(1);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(1);
        expect(reloadTaskRegistryFromStore).toHaveBeenCalledTimes(1);
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
        const { runtime, exited } = createRuntimeWithExitSignal();
        const start = vi.fn(async () => {
          await startupNeverReturns;
          return { close };
        });

        const { runGatewayLoop } = await import("./run-loop.js");
        void runGatewayLoop({
          start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        });
        await vi.advanceTimersByTimeAsync(0);
        const sigusr1 = captureSignal("SIGUSR1");

        sigusr1();
        await vi.advanceTimersByTimeAsync(0);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
        expect(markGatewayDraining).toHaveBeenCalledTimes(1);
        expect(runtime.exit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(24_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(exited).resolves.toBe(1);
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
        return { close };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
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
        return { close };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
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
      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
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
      start.mockResolvedValueOnce({ close: closeFirst });
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
        return { close: closeThird };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      try {
        sigusr1();

        await waitForLoopCondition(
          () => start.mock.calls.length >= 3,
          "expected queued SIGUSR1 to advance past failed restart startup",
        );
        await startedThird;
        expectRestartCloseCall(closeFirst, 90_000);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
        expect(markGatewayDraining).toHaveBeenCalledTimes(2);
        expect(resetAllLanes).toHaveBeenCalledTimes(2);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
        expect(reloadTaskRegistryFromStore).toHaveBeenCalledTimes(2);
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
      start.mockResolvedValueOnce({ close: closeFirst });
      start.mockRejectedValueOnce(new Error("restart startup failed"));
      start.mockImplementationOnce(async () => {
        resolveThirdStart?.();
        return { close: closeThird };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
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
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(start).toHaveBeenCalledTimes(2);

        sigusr1();
        await waitForLoopCondition(
          () => start.mock.calls.length >= 3,
          "expected post-failure SIGUSR1 to retry gateway startup",
        );
        await startedThird;
        expectRestartCloseCall(closeFirst, 90_000);
        expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
        expect(markGatewayDraining).toHaveBeenCalledTimes(2);
        expect(resetAllLanes).toHaveBeenCalledTimes(2);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
        expect(reloadTaskRegistryFromStore).toHaveBeenCalledTimes(2);
        expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
      } finally {
        sigterm();
        await expect(exited).resolves.toBe(0);
      }
    });
  });

  it("uses the default restart drain timeout when config omits deferralTimeoutMs", async () => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({ gateway: { reload: {} } });
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      getActiveTaskCount.mockReturnValueOnce(1).mockReturnValue(0);

      const { start } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForActiveTasks).toHaveBeenCalledWith(DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(markGatewayDraining).toHaveBeenCalledOnce();
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
      await new Promise<void>((resolve) => setImmediate(resolve));

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
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
      );
    });
  });

  it("releases the lock before exiting on spawned restart", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
    const originalTraceEnv = process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const lockRelease = vi.fn(async () => {});
        acquireGatewayLock.mockResolvedValueOnce({
          release: lockRelease,
        });

        // Override process-respawn to return "spawned" mode
        restartGatewayProcessWithFreshPid.mockReturnValueOnce({
          mode: "spawned",
          pid: 9999,
        });

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
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
      });
    } finally {
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
      process.env.LAUNCH_JOB_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
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
      delete process.env.LAUNCH_JOB_LABEL;
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
      process.env.LAUNCH_JOB_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
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
      delete process.env.LAUNCH_JOB_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
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
        .mockResolvedValueOnce({ close: closeFirst })
        .mockResolvedValueOnce({ close: closeSecond })
        .mockResolvedValueOnce({ close: closeThird });
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        lockPort: 18789,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      sigusr1();

      await new Promise<void>((resolve) => setImmediate(resolve));
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

  it("writes a handoff before exiting for supervised update restarts", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "supervised",
    });
    try {
      setPlatform("freebsd");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");

        sigusr1();

        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expectRestartHandoffCall({
          restartKind: "update-process",
          reason: "update.run",
          supervisorMode: "external",
        });
      });
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
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
        .mockResolvedValueOnce({ close: closeFirst })
        .mockResolvedValueOnce({ close: closeSecond });

      await runLoopWithStart({ start, runtime, lockPort: 18789, waitForHealthyChild });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForHealthyChild).toHaveBeenCalledWith(18789, 8888, "127.0.0.1");
      expect(kill).toHaveBeenCalledTimes(1);
      expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith("restart-unhealthy");
      expect(start).toHaveBeenCalledTimes(2);

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
