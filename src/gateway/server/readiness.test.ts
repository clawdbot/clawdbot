import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "../server-channels.js";
import { createReadinessChecker } from "./readiness.js";

const FIVE_MIN_MS = 5 * 60_000;
const THIRTY_ONE_MIN_MS = 31 * 60_000;

function snapshotWith(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};

  for (const [channelId, accountSnapshot] of Object.entries(accounts)) {
    const resolved = { accountId: "default", ...accountSnapshot } as ChannelAccountSnapshot;
    channels[channelId as ChannelId] = resolved;
    channelAccounts[channelId as ChannelId] = { default: resolved };
  }

  return { channels, channelAccounts };
}

function createManager(snapshot: ChannelRuntimeSnapshot): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    startChannels: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
  };
}

function createHealthyDiscordManager(
  startedAt: number,
  lastTransportActivityAt: number,
): ChannelManager {
  return createManager(
    snapshotWith({
      discord: managedAccount({
        lastStartAt: startedAt,
        lastTransportActivityAt,
      }),
    }),
  );
}

function withReadinessClock(run: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

function createReadinessHarness(params: {
  startedAgoMs?: number;
  accounts?: Record<string, Partial<ChannelAccountSnapshot>>;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: Parameters<typeof createReadinessChecker>[0]["getStartupPendingReason"];
  getEventLoopHealth?: Parameters<typeof createReadinessChecker>[0]["getEventLoopHealth"];
  shouldSkipChannelReadiness?: Parameters<
    typeof createReadinessChecker
  >[0]["shouldSkipChannelReadiness"];
  cacheTtlMs?: number;
}) {
  const startedAt = Date.now() - (params.startedAgoMs ?? FIVE_MIN_MS);
  const manager = createManager(snapshotWith(params.accounts ?? {}));
  return {
    manager,
    readiness: createReadinessChecker({
      channelManager: manager,
      startedAt,
      getStartupPending: params.getStartupPending,
      getStartupPendingReason: params.getStartupPendingReason,
      getEventLoopHealth: params.getEventLoopHealth,
      shouldSkipChannelReadiness: params.shouldSkipChannelReadiness,
      cacheTtlMs: params.cacheTtlMs,
    }),
  };
}

function managedAccount(
  overrides: Partial<ChannelAccountSnapshot> = {},
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: true,
    enabled: true,
    configured: true,
    lastStartAt: Date.now() - FIVE_MIN_MS,
    ...overrides,
  };
}

function stoppedAccount(
  overrides: Partial<ChannelAccountSnapshot> = {},
): Partial<ChannelAccountSnapshot> {
  return managedAccount({
    running: false,
    ...overrides,
  });
}

function createLongRunningReadinessHarness(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
) {
  return createReadinessHarness({
    startedAgoMs: THIRTY_ONE_MIN_MS,
    accounts,
  });
}

function readySnapshot(
  uptimeMs = FIVE_MIN_MS,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ready: true, failing: [], uptimeMs, ...extra };
}

function failingSnapshot(failing: string[], uptimeMs = FIVE_MIN_MS): Record<string, unknown> {
  return { ready: false, failing, uptimeMs };
}

describe("createReadinessChecker", () => {
  it("reports ready when all managed channels are healthy", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - FIVE_MIN_MS;
      const manager = createHealthyDiscordManager(startedAt, Date.now() - 1_000);

      const readiness = createReadinessChecker({ channelManager: manager, startedAt });
      expect(readiness()).toEqual(readySnapshot());
    });
  });

  it("keeps readiness red while startup sidecars are pending", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        getStartupPending: () => true,
      });
      expect(readiness()).toEqual(failingSnapshot(["startup-sidecars"]));
    });
  });

  it("reports the current startup pending reason", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        getStartupPending: () => true,
        getStartupPendingReason: () => "startup-sidecars",
      });
      expect(readiness()).toEqual(failingSnapshot(["startup-sidecars"]));
    });
  });

  it("does not cache startup-pending readiness", () => {
    withReadinessClock(() => {
      let startupPending = true;
      const { manager, readiness } = createReadinessHarness({
        getStartupPending: () => startupPending,
        cacheTtlMs: 1_000,
      });
      expect(readiness()).toEqual(failingSnapshot(["startup-sidecars"]));
      expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();

      startupPending = false;
      expect(readiness()).toEqual(readySnapshot());
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores disabled and unconfigured channels", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: stoppedAccount({
            enabled: false,
          }),
          telegram: stoppedAccount({
            configured: false,
          }),
        },
      });
      expect(readiness()).toEqual(readySnapshot());
    });
  });

  it("uses startup grace before marking disconnected channels not ready", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 30_000,
        accounts: {
          discord: managedAccount({
            connected: false,
            lastStartAt: Date.now() - 30_000,
          }),
        },
      });
      expect(readiness()).toEqual(readySnapshot(30_000));
    });
  });

  it("reports disconnected managed channels after startup grace", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: managedAccount({
            connected: false,
          }),
        },
      });
      expect(readiness()).toEqual(failingSnapshot(["discord"]));
    });
  });

  it("treats intentionally skipped channels as ready", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        accounts: {
          discord: stoppedAccount(),
          telegram: stoppedAccount(),
        },
        shouldSkipChannelReadiness: () => true,
      });

      expect(readiness()).toEqual(readySnapshot());
      expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    });
  });

  it("keeps restart-pending channels ready during reconnect backoff", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - FIVE_MIN_MS;
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: managedAccount({
            running: false,
            restartPending: true,
            reconnectAttempts: 3,
            lastStartAt: startedAt - 30_000,
            lastStopAt: Date.now() - 5_000,
          }),
        },
      });
      expect(readiness()).toEqual(readySnapshot());
    });
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    withReadinessClock(() => {
      const { readiness } = createLongRunningReadinessHarness({
        discord: managedAccount({
          lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
          lastTransportActivityAt: Date.now() - THIRTY_ONE_MIN_MS,
        }),
      });
      expect(readiness()).toEqual(readySnapshot(THIRTY_ONE_MIN_MS));
    });
  });

  it("keeps telegram long-polling channels ready without stale-socket classification", () => {
    withReadinessClock(() => {
      const { readiness } = createLongRunningReadinessHarness({
        telegram: managedAccount({
          lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
          lastTransportActivityAt: null,
        }),
      });
      expect(readiness()).toEqual(readySnapshot(THIRTY_ONE_MIN_MS));
    });
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        accounts: {
          discord: managedAccount({
            lastTransportActivityAt: Date.now() - 1_000,
          }),
        },
        cacheTtlMs: 1_000,
      });
      expect(readiness()).toEqual(readySnapshot());
      vi.advanceTimersByTime(500);
      expect(readiness()).toEqual(readySnapshot(300_500));
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      expect(readiness()).toEqual(readySnapshot(301_100));
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("adds event-loop health to detailed readiness without changing readiness state", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        getEventLoopHealth: () => ({
          degraded: true,
          reasons: ["cpu", "event_loop_utilization"],
          intervalMs: 2_000,
          delayP99Ms: 42.1,
          delayMaxMs: 88.7,
          utilization: 0.991,
          cpuCoreRatio: 0.973,
        }),
      });

      expect(readiness()).toEqual(
        readySnapshot(FIVE_MIN_MS, {
          eventLoop: {
            degraded: true,
            reasons: ["cpu", "event_loop_utilization"],
            intervalMs: 2_000,
            delayP99Ms: 42.1,
            delayMaxMs: 88.7,
            utilization: 0.991,
            cpuCoreRatio: 0.973,
          },
        }),
      );
    });
  });
});
