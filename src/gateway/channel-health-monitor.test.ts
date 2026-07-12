/**
 * Channel health monitor regression tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "./server-channels.js";

function createMockChannelManager(overrides?: Partial<ChannelManager>): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => ({ channels: {}, channelAccounts: {} })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    setAutostartSuppression: vi.fn(),
    getAutostartSuppression: vi.fn(() => null),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
    ...overrides,
  };
}

function snapshotWith(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
  for (const [channelId, accts] of Object.entries(accounts)) {
    const resolved: Record<string, ChannelAccountSnapshot> = {};
    for (const [accountId, partial] of Object.entries(accts)) {
      resolved[accountId] = { accountId, ...partial };
    }
    channelAccounts[channelId as ChannelId] = resolved;
    const firstId = Object.keys(accts)[0];
    if (firstId) {
      channels[channelId as ChannelId] = resolved[firstId];
    }
  }
  return { channels, channelAccounts };
}

const DEFAULT_CHECK_INTERVAL_MS = 5_000;

function createSnapshotManager(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createMockChannelManager({
    getRuntimeSnapshot: vi.fn(() => snapshotWith(accounts)),
    ...overrides,
  });
}

function startDefaultMonitor(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  return startChannelHealthMonitor({
    channelManager: manager,
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    startupGraceMs: 0,
    ...overrides,
  });
}

async function startAndRunCheck(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  const monitor = startDefaultMonitor(manager, overrides);
  const startupGraceMs = overrides.timing?.monitorStartupGraceMs ?? overrides.startupGraceMs ?? 0;
  const checkIntervalMs = overrides.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  await vi.advanceTimersByTimeAsync(startupGraceMs + checkIntervalMs + 1);
  return monitor;
}

function managedStoppedAccount(lastError: string): Partial<ChannelAccountSnapshot> {
  return {
    running: false,
    enabled: true,
    configured: true,
    lastError,
  };
}

function runningConnectedSlackAccount(
  overrides: Partial<ChannelAccountSnapshot>,
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function disconnectedAccount(
  lastStartAt: number,
  overrides: Partial<ChannelAccountSnapshot> = {},
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: false,
    enabled: true,
    configured: true,
    lastStartAt,
    ...overrides,
  };
}

function createSlackSnapshotManager(
  account: Partial<ChannelAccountSnapshot>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createSnapshotManager(
    {
      slack: {
        default: account,
      },
    },
    overrides,
  );
}

function createBusyDisconnectedManager(lastRunActivityAt: number): ChannelManager {
  const now = Date.now();
  return createSnapshotManager({
    discord: {
      default: {
        ...disconnectedAccount(now - 300_000),
        activeRuns: 1,
        busy: true,
        lastRunActivityAt,
      },
    },
  });
}

async function expectRestartedChannel(
  manager: ChannelManager,
  channel: ChannelId,
  accountId = "default",
) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).toHaveBeenCalledWith(channel, accountId, { manual: false });
  expect(manager.startChannel).toHaveBeenCalledWith(channel, accountId);
  monitor.stop();
}

async function expectNoRestart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).not.toHaveBeenCalled();
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

async function expectNoStart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

async function advanceHealthCheck() {
  await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
}

describe("channel-health-monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes abort listener when stopped manually", () => {
    const signal = new AbortController().signal;
    const addEventListener = vi.spyOn(signal, "addEventListener");
    const removeEventListener = vi.spyOn(signal, "removeEventListener");
    const monitor = startDefaultMonitor(createMockChannelManager(), { abortSignal: signal });

    monitor.stop();

    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith("abort", addEventListener.mock.calls[0]?.[1]);
  });

  it("normalizes oversized check intervals before arming timers", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const monitor = startDefaultMonitor(createMockChannelManager(), {
      checkIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    monitor.stop();
  });

  it("does not run before the grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { startupGraceMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("runs health check after grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = await startAndRunCheck(manager, { startupGraceMs: 1_000 });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalled();
    monitor.stop();
  });

  it("keeps running after a runtime snapshot failure", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("snapshot failed");
        })
        .mockReturnValue({ channels: {}, channelAccounts: {} }),
    });
    const monitor = startDefaultMonitor(manager);

    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);

    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("accepts timing.monitorStartupGraceMs", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { timing: { monitorStartupGraceMs: 60_000 } });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips healthy channels (running + connected)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { running: true, connected: true, enabled: true, configured: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats crash-loop suppressed accounts as expected stopped", async () => {
    let suppressed = true;
    const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
    const manager = createSnapshotManager(
      {
        discord: {
          default: managedStoppedAccount("safe mode"),
        },
      },
      {
        getAutostartSuppression: vi.fn(() => (suppressed ? suppression : null)),
      },
    );
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 100,
      cooldownCycles: 0,
      maxRestartsPerHour: 1,
    });

    await vi.advanceTimersByTimeAsync(350);

    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();

    suppressed = false;
    await vi.advanceTimersByTimeAsync(101);

    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it("skips disabled channels", async () => {
    const manager = createSnapshotManager({
      imessage: {
        default: {
          running: false,
          enabled: false,
          configured: true,
          lastError: "disabled",
        },
      },
    });
    await expectNoStart(manager);
  });

  it("skips unconfigured channels", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { running: false, enabled: true, configured: false },
      },
    });
    await expectNoStart(manager);
  });

  it("does not restart a channel with terminalDisconnect set", async () => {
    const manager = createSnapshotManager({
      whatsapp: {
        default: {
          running: false,
          enabled: true,
          configured: true,
          terminalDisconnect: true,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("restarts a stopped channel without terminalDisconnect", async () => {
    const manager = createSnapshotManager({
      whatsapp: {
        default: {
          running: false,
          enabled: true,
          configured: true,
          terminalDisconnect: false,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("skips manually stopped channels", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { running: false, enabled: true, configured: true },
        },
      },
      { isManuallyStopped: vi.fn(() => true) },
    );
    await expectNoStart(manager);
  });

  it("skips channels with health monitor disabled globally for that account", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { running: false, enabled: true, configured: true },
        },
      },
      { isHealthMonitorEnabled: vi.fn(() => false) },
    );
    await expectNoStart(manager);
  });

  it("still restarts enabled accounts when another account on the same channel is disabled", async () => {
    const now = Date.now();
    const manager = createSnapshotManager(
      {
        discord: {
          default: disconnectedAccount(now - 300_000),
          quiet: disconnectedAccount(now - 300_000),
        },
      },
      {
        isHealthMonitorEnabled: vi.fn((channelId: ChannelId, accountId: string) => {
          return !(channelId === "discord" && accountId === "quiet");
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("discord", "default", { manual: false });
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.stopChannel).not.toHaveBeenCalledWith("discord", "quiet", { manual: false });
    expect(manager.startChannel).not.toHaveBeenCalledWith("discord", "quiet");
    monitor.stop();
  });

  it("restarts a stuck channel (running but not connected)", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      whatsapp: {
        default: disconnectedAccount(now - 300_000, {
          linked: true,
        }),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("whatsapp", "default", { manual: false });
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("skips restart when channel is busy with active runs", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: disconnectedAccount(now - 300_000, {
          activeRuns: 2,
          busy: true,
          lastRunActivityAt: now - 30_000,
        }),
      },
    });
    await expectNoRestart(manager);
  });

  it("restarts busy channels when run activity is stale", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 26 * 60_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("restarts disconnected channels when busy flags are inherited from a prior lifecycle", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 301_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("skips recently-started channels while they are still connecting", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 5_000,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("respects custom per-channel startup grace", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 30_000,
        },
      },
    });
    const monitor = await startAndRunCheck(manager, { channelStartupGraceMs: 60_000 });
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("restarts a stopped channel that gave up (reconnectAttempts >= 10)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: {
          ...managedStoppedAccount("Failed to resolve Discord application id"),
          reconnectAttempts: 10,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it("restarts a channel that stopped unexpectedly (not running, not manual)", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: managedStoppedAccount("polling stopped unexpectedly"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("telegram", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("treats missing enabled/configured flags as managed accounts", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: {
          running: false,
          lastError: "polling stopped unexpectedly",
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("applies cooldown — skips recently restarted channels for 2 cycles", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("crashed"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("continues pending recovery on the next check without waiting for cooldown", async () => {
    const account: Partial<ChannelAccountSnapshot> = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      {
        discord: {
          default: account,
        },
      },
      {
        startChannel: vi.fn(async () => {
          account.running = false;
          account.connected = false;
          account.restartPending = true;
          account.reconnectAttempts = 0;
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledTimes(1);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);

    await advanceHealthCheck();

    expect(manager.stopChannel).toHaveBeenCalledTimes(1);
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("caps at 3 health-monitor restarts per channel per hour", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("keeps crashing"),
      },
    });
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1_000,
      cooldownCycles: 1,
      maxRestartsPerHour: 3,
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("counts failed restart attempts toward cooldown and hourly caps", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: managedStoppedAccount("keeps crashing"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          throw new Error("startup failed");
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1_000,
      cooldownCycles: 1,
      maxRestartsPerHour: 1,
    });

    await vi.advanceTimersByTimeAsync(5_001);

    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it("runs checks single-flight when restart work is still in progress", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => resolve();
    });
    const manager = createSnapshotManager(
      {
        telegram: {
          default: managedStoppedAccount("stopped"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          await startGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });
    await vi.advanceTimersByTimeAsync(120);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    releaseStart?.();
    await Promise.resolve();
    monitor.stop();
  });

  it.each(["manual stop", "abort signal"] as const)(
    "does not resume an in-flight restart after %s",
    async (stopMode) => {
      let releaseStop: (() => void) | undefined;
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const abort = new AbortController();
      const manager = createSlackSnapshotManager(disconnectedAccount(Date.now() - 300_000), {
        stopChannel: vi.fn(async () => {
          await stopGate;
        }),
      });
      const monitor = startDefaultMonitor(manager, {
        abortSignal: abort.signal,
        checkIntervalMs: 100,
        cooldownCycles: 0,
      });

      await vi.advanceTimersByTimeAsync(101);
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);

      if (stopMode === "manual stop") {
        monitor.shutdown();
      } else {
        abort.abort();
      }
      releaseStop?.();
      await monitor.waitForIdle();

      expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
      expect(manager.startChannel).not.toHaveBeenCalled();
      monitor.stop();
    },
  );

  it("does not process later accounts after a retired monitor's stop rejects", async () => {
    let rejectStop: (() => void) | undefined;
    const stopGate = new Promise<void>((_resolve, reject) => {
      rejectStop = () => reject(new Error("stop failed"));
    });
    const staleAccount = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      { slack: { first: staleAccount, second: staleAccount } },
      {
        stopChannel: vi.fn(async () => {
          await stopGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });

    await vi.advanceTimersByTimeAsync(101);
    expect(manager.stopChannel).toHaveBeenCalledTimes(1);

    monitor.shutdown();
    rejectStop?.();
    await monitor.waitForIdle();

    expect(manager.stopChannel).toHaveBeenCalledTimes(1);
    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
  });

  it.each([
    { label: "replacement", shutdownAfterRetire: false, expectedStarts: 1 },
    { label: "replacement followed by shutdown", shutdownAfterRetire: true, expectedStarts: 0 },
  ])("coordinates the in-flight restart during $label", async (testCase) => {
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const staleAccount = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      { slack: { first: staleAccount, second: staleAccount } },
      {
        stopChannel: vi.fn(async () => {
          await stopGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });

    await vi.advanceTimersByTimeAsync(101);
    expect(manager.stopChannel).toHaveBeenCalledTimes(1);

    monitor.stop();
    const idle = monitor.waitForIdle();
    if (testCase.shutdownAfterRetire) {
      monitor.shutdown();
    }
    releaseStop?.();
    await idle;

    expect(manager.stopChannel).toHaveBeenCalledTimes(1);
    expect(manager.resetRestartAttempts).toHaveBeenCalledTimes(testCase.expectedStarts);
    expect(manager.startChannel).toHaveBeenCalledTimes(testCase.expectedStarts);
  });

  it("bounds replacement handoff and abandons a late restart", async () => {
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const manager = createSlackSnapshotManager(disconnectedAccount(Date.now() - 300_000), {
      stopChannel: vi.fn(async () => {
        await stopGate;
      }),
    });
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });

    await vi.advanceTimersByTimeAsync(101);
    monitor.stop();
    const handoff = monitor.waitForIdle();
    await vi.advanceTimersByTimeAsync(5_001);
    await handoff;

    releaseStop?.();
    await monitor.waitForIdle();

    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
  });

  it("stops cleanly", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("stops via abort signal", async () => {
    const manager = createMockChannelManager();
    const abort = new AbortController();
    const monitor = startDefaultMonitor(manager, { abortSignal: abort.signal });
    abort.abort();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats running channels without a connected field as healthy", async () => {
    const manager = createSnapshotManager({
      slack: {
        default: { running: true, enabled: true, configured: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  describe("stale socket detection", () => {
    const STALE_THRESHOLD = 30 * 60_000;

    it("restarts a channel with no transport activity past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastTransportActivityAt: now - STALE_THRESHOLD - 30_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips channels with recent transport activity", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastTransportActivityAt: now - 5_000,
        }),
      );
      await expectNoRestart(manager);
    });

    it("skips channels still within the startup grace window for stale detection", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - 5_000,
          lastTransportActivityAt: null,
        }),
      );
      await expectNoRestart(manager);
    });

    it("restarts a channel with no transport activity since connect past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastTransportActivityAt: now - STALE_THRESHOLD - 60_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips connected channels that do not report transport liveness", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: now - STALE_THRESHOLD - 60_000,
            lastTransportActivityAt: null,
          },
        },
      });
      await expectNoRestart(manager);
    });

    it("respects custom staleEventThresholdMs", async () => {
      const customThreshold = 10 * 60_000;
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - customThreshold - 60_000,
          lastTransportActivityAt: now - customThreshold - 30_000,
        }),
      );
      const monitor = await startAndRunCheck(manager, {
        staleEventThresholdMs: customThreshold,
      });
      expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default", { manual: false });
      expect(manager.startChannel).toHaveBeenCalledWith("slack", "default");
      monitor.stop();
    });
  });
});
