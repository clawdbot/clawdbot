import { describe, expect, it, vi } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const consumeGatewayRestartIntentSync = vi.fn(() => false);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
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
const markGatewayDraining = vi.fn();
const waitForActiveTasks = vi.fn(async (_timeoutMs?: number) => ({ drained: true }));
const resetAllLanes = vi.fn();
const getActiveBundledRuntimeDepsInstallCount = vi.fn(() => 0);
const waitForBundledRuntimeDepsInstallIdle = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
const restartGatewayProcessWithFreshPid = vi.fn<
  () => { mode: "spawned" | "supervised" | "disabled" | "failed"; pid?: number; detail?: string }
>(() => ({ mode: "disabled" }));
const abortEmbeddedPiRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting" }) => false,
);
const getActiveEmbeddedRunCount = vi.fn(() => 0);
const waitForActiveEmbeddedRuns = vi.fn(async (_timeoutMs?: number) => ({ drained: true }));
const DRAIN_TIMEOUT_LOG = "drain timeout reached; proceeding with restart";
const loadConfig = vi.fn(() => ({
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
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  consumeGatewayRestartIntentSync: () => consumeGatewayRestartIntentSync(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
  scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
    scheduleGatewaySigusr1Restart(opts),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  restartGatewayProcessWithFreshPid: () => restartGatewayProcessWithFreshPid(),
}));

vi.mock("../../process/command-queue.js", () => ({
  getActiveTaskCount: () => getActiveTaskCount(),
  markGatewayDraining: () => markGatewayDraining(),
  waitForActiveTasks: (timeoutMs?: number) => waitForActiveTasks(timeoutMs),
  resetAllLanes: () => resetAllLanes(),
}));

vi.mock("../../plugins/bundled-runtime-deps-activity.js", () => ({
  getActiveBundledRuntimeDepsInstallCount: () => getActiveBundledRuntimeDepsInstallCount(),
  waitForBundledRuntimeDepsInstallIdle: (timeoutMs?: number) =>
    waitForBundledRuntimeDepsInstallIdle(timeoutMs),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (sessionId?: string, opts?: { mode?: "all" | "compacting" }) =>
    abortEmbeddedPiRun(sessionId, opts),
  getActiveEmbeddedRunCount: () => getActiveEmbeddedRunCount(),
  waitForActiveEmbeddedRuns: (timeoutMs?: number) => waitForActiveEmbeddedRuns(timeoutMs),
}));

vi.mock("../../config/config.js", () => ({
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

type GatewayCloseFn = (...args: unknown[]) => Promise<void>;
type LoopRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

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
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    lockPort: params.lockPort,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createSignaledLoopHarness(exitCallOrder?: string[]) {
  const close = vi.fn(async () => {});
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
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
    consumeGatewayRestartIntentSync.mockReturnValueOnce(true);
    getActiveTaskCount.mockReturnValueOnce(1).mockReturnValue(0);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const start = vi
        .fn()
        .mockResolvedValueOnce({ close: closeFirst })
        .mockResolvedValueOnce({ close: closeSecond });
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

      expect(consumeGatewayRestartIntentSync).toHaveBeenCalledOnce();
      expect(markGatewayDraining).toHaveBeenCalledOnce();
      expect(waitForActiveTasks).toHaveBeenCalledWith(90_000);
      expect(closeFirst).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
      expect(closeSecond).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it("restarts after SIGUSR1 even when drain times out, and resets lanes for the new iteration", async () => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({
      gateway: {
        reload: {
          deferralTimeoutMs: 1_234,
        },
      },
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      getActiveTaskCount.mockReturnValueOnce(2).mockReturnValueOnce(0);
      getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValueOnce(0);
      waitForActiveTasks.mockResolvedValueOnce({ drained: false });
      waitForActiveEmbeddedRuns.mockResolvedValueOnce({ drained: true });

      type StartServer = () => Promise<{
        close: (opts: { reason: string; restartExpectedMs: number | null }) => Promise<void>;
      }>;

      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
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
      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(DRAIN_TIMEOUT_LOG);
      expect(closeFirst).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(resetAllLanes).toHaveBeenCalledTimes(1);

      sigusr1();

      await startedThird;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSecond).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
      expect(markGatewayDraining).toHaveBeenCalledTimes(2);
      expect(resetAllLanes).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it("routes external SIGUSR1 through the restart scheduler before draining", async () => {
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
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(markGatewaySigusr1RestartHandled).not.toHaveBeenCalled();
    });
  });

  it("waits for active runtime-deps installs before restart close", async () => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({
      gateway: {
        reload: {
          deferralTimeoutMs: 90_000,
        },
      },
    });
    let releaseRuntimeDeps!: () => void;
    getActiveBundledRuntimeDepsInstallCount.mockReturnValueOnce(1).mockReturnValue(0);
    waitForBundledRuntimeDepsInstallIdle.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRuntimeDeps = () => resolve({ drained: true, active: 0 });
      }),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(markGatewayDraining).toHaveBeenCalledOnce();
      expect(waitForBundledRuntimeDepsInstallIdle).toHaveBeenCalledWith(90_000);
      expect(close).not.toHaveBeenCalled();

      releaseRuntimeDeps();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(close).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  it("releases the lock before exiting on spawned restart", async () => {
    vi.clearAllMocks();

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
      expect(lockRelease).toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
    });
  });

  it("waits briefly before exiting on launchd supervised restart", async () => {
    vi.clearAllMocks();
    try {
      setPlatform("darwin");
      process.env.LAUNCH_JOB_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const startedAt = Date.now();

        sigusr1();
        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
      });
    } finally {
      delete process.env.LAUNCH_JOB_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("forwards lockPort to initial and restart lock acquisitions", async () => {
    vi.clearAllMocks();

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
        expect.stringContaining("failed to reacquire gateway lock for in-process restart"),
      );
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
