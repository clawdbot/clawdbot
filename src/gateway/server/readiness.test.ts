// Readiness checker tests cover startup grace, channel health, and stale socket decisions.
import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { ChannelManager } from "../server-channels.js";
import { createReadinessChecker } from "./readiness.js";

/**
 * Readiness checker tests for startup grace, channel health, and stale sockets.
 */
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
    getPluginCommandCatalogAccounts: vi.fn(() => new Map()),
    startChannels: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    setAutostartSuppression: vi.fn(),
    getAutostartSuppression: vi.fn(() => null),
    recoverAutostartSuppression: vi.fn(async () => false),
    setAmbientAutostartSuppressedChannelIds: vi.fn(),
    isAmbientAutostartSuppressed: vi.fn(() => false),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    isAutoRestartScheduled: vi.fn(() => false),
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
  getGatewayDraining?: Parameters<typeof createReadinessChecker>[0]["getGatewayDraining"];
  getEventLoopHealth?: Parameters<typeof createReadinessChecker>[0]["getEventLoopHealth"];
  getStateDatabaseFailure?: Parameters<typeof createReadinessChecker>[0]["getStateDatabaseFailure"];
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
      getGatewayDraining: params.getGatewayDraining,
      getEventLoopHealth: params.getEventLoopHealth,
      getStateDatabaseFailure: params.getStateDatabaseFailure,
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

  it("reports not ready while the gateway command queue is draining for restart", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        getGatewayDraining: () => true,
        cacheTtlMs: 1_000,
      });

      expect(readiness()).toEqual(failingSnapshot(["gateway-draining"]));
      expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    });
  });

  it("does not cache gateway-draining readiness", () => {
    withReadinessClock(() => {
      let gatewayDraining = true;
      const { manager, readiness } = createReadinessHarness({
        getGatewayDraining: () => gatewayDraining,
        cacheTtlMs: 1_000,
      });

      expect(readiness()).toEqual(failingSnapshot(["gateway-draining"]));
      expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();

      gatewayDraining = false;
      expect(readiness()).toEqual(readySnapshot());
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it("reports a terminal state database failure after the readiness cache expires", () => {
    withReadinessClock(() => {
      const stateDatabase = { failure: undefined as Error | undefined };
      const { manager, readiness } = createReadinessHarness({
        getStateDatabaseFailure: () => stateDatabase.failure,
        cacheTtlMs: 1_000,
      });
      expect(readiness()).toEqual(readySnapshot());

      stateDatabase.failure = new Error("newer shared-state schema");
      vi.advanceTimersByTime(1_000);
      expect(readiness()).toEqual(failingSnapshot(["state-database"], FIVE_MIN_MS + 1_000));
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

  it("keeps a long-running Reef account ready during fresh reconnect grace", () => {
    withReadinessClock(() => {
      const { readiness } = createLongRunningReadinessHarness({
        reef: managedAccount({
          connected: false,
          lifecycle: "recovering",
          lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
          lastDisconnect: { at: Date.now() - 5_000, error: "socket closed" },
        }),
      });
      expect(readiness()).toEqual(readySnapshot(THIRTY_ONE_MIN_MS));
    });
  });

  it("uses fresh recorded lifecycle within connect grace", () => {
    withReadinessClock(() => {
      const { readiness } = createLongRunningReadinessHarness({
        discord: managedAccount({
          connected: false,
          lifecycle: "starting",
          lastStartAt: Date.now() - 30_000,
        }),
        slack: stoppedAccount({
          connected: false,
          lifecycle: "recovering",
          lastStartAt: Date.now() - 30_000,
        }),
      });
      expect(readiness()).toEqual(readySnapshot(THIRTY_ONE_MIN_MS));
    });
  });

  it("reports a recorded starting lifecycle that outlives connect grace", () => {
    withReadinessClock(() => {
      const { readiness } = createLongRunningReadinessHarness({
        discord: managedAccount({ connected: false, lifecycle: "starting" }),
      });
      expect(readiness()).toEqual(failingSnapshot(["discord"], THIRTY_ONE_MIN_MS));
    });
  });

  it("reports recorded blocked lifecycle as not ready", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          slack: managedAccount({ lifecycle: "blocked" }),
        },
      });
      expect(readiness()).toEqual(failingSnapshot(["slack"]));
    });
  });

  it("does not hide a ready lifecycle disconnect behind wall-clock grace", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 30_000,
        accounts: {
          discord: managedAccount({
            connected: false,
            lifecycle: "ready",
            lastStartAt: Date.now() - 30_000,
          }),
        },
      });
      expect(readiness()).toEqual(failingSnapshot(["discord"], 30_000));
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

  it("reports crash-loop suppressed stopped channels without failing readiness", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        accounts: {
          discord: stoppedAccount({
            restartPending: false,
            lastError: "safe mode",
          }),
        },
      });
      vi.mocked(manager.getAutostartSuppression).mockReturnValue({
        reason: "crash-loop-breaker",
        message: "safe mode",
      });

      expect(readiness()).toEqual(readySnapshot(FIVE_MIN_MS, { suppressed: ["discord"] }));
    });
  });

  it("reports ambient-suppressed dev channels without failing readiness", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        accounts: {
          discord: stoppedAccount({
            restartPending: false,
            lastError: "ambient credentials suppressed",
          }),
        },
      });
      vi.mocked(manager.isAmbientAutostartSuppressed).mockImplementation(
        (channelId) => channelId === "discord",
      );

      expect(readiness()).toEqual(readySnapshot(FIVE_MIN_MS, { suppressed: ["discord"] }));
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

  it("keeps a dead-ingress channel ready while its restart backoff is still pending", () => {
    // The next start re-proves ingress, so this window gets the same grace as any
    // other restart handoff rather than flapping readiness on every retry.
    withReadinessClock(() => {
      const startedAt = Date.now() - FIVE_MIN_MS;
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: managedAccount({
            running: false,
            restartPending: true,
            ingressUnavailable: true,
            reconnectAttempts: 3,
            lastStartAt: startedAt - 30_000,
            lastStopAt: Date.now() - 5_000,
          }),
        },
      });
      expect(readiness()).toEqual(readySnapshot());
    });
  });

  it("fails readiness for dead ingress once the restart ladder stops retrying", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: managedAccount({
            running: false,
            restartPending: false,
            ingressUnavailable: true,
            reconnectAttempts: 11,
          }),
        },
      });
      expect(readiness()).toEqual(failingSnapshot(["discord"]));
    });
  });

  it("fails readiness for a running channel whose transport is up but ingress is dead", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: managedAccount({
            running: true,
            connected: true,
            restartPending: true,
            ingressUnavailable: true,
            lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
          }),
        },
      });
      expect(readiness()).toEqual(failingSnapshot(["discord"]));
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

  it("refreshes stopped channels when the clock moves behind cached readiness", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        accounts: { discord: managedAccount({ lifecycle: "ready" }) },
        cacheTtlMs: 1_000,
      });

      expect(readiness()).toEqual(readySnapshot());
      vi.mocked(manager.getRuntimeSnapshot).mockReturnValue(
        snapshotWith({ discord: stoppedAccount({ connected: false, lifecycle: "stopped" }) }),
      );
      vi.setSystemTime(Date.now() - 60_000);

      expect(readiness()).toEqual(failingSnapshot(["discord"], FIVE_MIN_MS - 60_000));
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("adds event-loop health to detailed readiness without changing readiness state", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        getEventLoopHealth: () => ({
          degraded: true,
          degradedSinceMs: 61_000,
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
            degradedSinceMs: 61_000,
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
