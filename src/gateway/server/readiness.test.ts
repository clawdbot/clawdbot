// Readiness checker tests cover startup grace, channel health, and stale socket decisions.
import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  buildHostingProfileConditions,
  buildHostingProfileSubjects,
} from "../../hosting/profiles.js";
import { buildRuntimeReadiness, type ReadinessCondition } from "../../readiness/conditions.js";
import { createGatewayReadinessIdentity } from "../../readiness/subjects.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { ChannelManager } from "../server-channels.js";
import { createReadinessChecker, evaluateConfiguredGatewayReadiness } from "./readiness.js";

type ReadinessResult = Awaited<ReturnType<ReturnType<typeof createReadinessChecker>>>;

/**
 * Readiness checker tests for startup grace, channel health, and stale sockets.
 */
const FIVE_MIN_MS = 5 * 60_000;
const THIRTY_ONE_MIN_MS = 31 * 60_000;

function testReadinessIdentity() {
  return createGatewayReadinessIdentity({ createGatewayInstanceId: () => "gateway-test" });
}

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
  const eventLoop = extra.eventLoop as { degraded: boolean; reasons: string[] } | undefined;
  return {
    ready: true,
    failing: [],
    uptimeMs,
    conditions: coreConditions({
      eventLoop,
      suppressed: extra.suppressed as string[] | undefined,
    }),
    ...extra,
  };
}

function failingSnapshot(
  failing: string[],
  uptimeMs = FIVE_MIN_MS,
  startupPendingReason?: string,
): ReadinessResult {
  const draining = failing.includes("gateway-draining");
  const startupPending = !draining && failing.includes("startup-sidecars");
  return {
    ready: false,
    failing,
    uptimeMs,
    conditions: coreConditions({
      startupPending,
      startupPendingReason,
      draining,
      channelFailing: startupPending || draining ? undefined : failing,
    }),
  };
}

function coreConditions(
  params: {
    startupPending?: boolean;
    startupPendingReason?: string;
    draining?: boolean;
    channelFailing?: string[];
    suppressed?: string[];
    eventLoop?: { degraded: boolean; reasons: string[] };
  } = {},
): ReadinessCondition[] {
  const channelChecked =
    params.channelFailing !== undefined || (!params.startupPending && !params.draining);
  const channelFailing = params.channelFailing ?? [];
  const eventLoop = params.eventLoop;
  const conditions: ReadinessCondition[] = [
    {
      type: "GatewayStartupComplete",
      status: params.startupPending ? "False" : "True",
      requirement: "required",
      reason: params.startupPending ? "GatewayStartupPending" : "GatewayStartupComplete",
      message: params.startupPending
        ? `Gateway startup dependencies are still pending${params.startupPendingReason ? `: ${params.startupPendingReason}` : ""}.`
        : "Gateway startup dependencies are complete.",
    },
    {
      type: "GatewayAcceptingWork",
      status: params.draining ? "False" : "True",
      requirement: "required",
      reason: params.draining ? "GatewayDraining" : "GatewayAcceptingWork",
      message: params.draining
        ? "Gateway is draining and is not accepting new work."
        : "Gateway is accepting new work.",
    },
    {
      type: "ChannelRuntimeReady",
      status: !channelChecked ? "Unknown" : channelFailing.length > 0 ? "False" : "True",
      requirement: "required",
      reason: !channelChecked
        ? "ChannelRuntimeNotChecked"
        : channelFailing.length > 0
          ? "ChannelRuntimeUnavailable"
          : "ChannelRuntimeReady",
      message: !channelChecked
        ? "Channel runtime health was not evaluated on this readiness pass."
        : channelFailing.length > 0
          ? `Selected channels are not ready: ${channelFailing.join(", ")}.`
          : "Selected channel runtimes are ready.",
    },
  ];
  if (params.suppressed?.length) {
    conditions.push({
      type: "ChannelRuntimeSuppressed",
      status: "False",
      requirement: "advisory",
      reason: "ChannelRuntimeSuppressed",
      message: `Channel runtime failures are suppressed: ${params.suppressed.join(", ")}.`,
    });
  }
  conditions.push({
    type: "EventLoopHealthy",
    status: !eventLoop ? "Unknown" : eventLoop.degraded ? "False" : "True",
    requirement: "advisory",
    reason: !eventLoop
      ? "EventLoopStatusUnavailable"
      : eventLoop.degraded
        ? "EventLoopDegraded"
        : "EventLoopHealthy",
    message: !eventLoop
      ? "Event-loop health is not available yet."
      : eventLoop.degraded
        ? `Event-loop health is degraded: ${eventLoop.reasons.join(", ")}.`
        : "Event-loop health is within its healthy thresholds.",
  });
  return conditions;
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
      expect(readiness()).toEqual(
        failingSnapshot(["startup-sidecars"], FIVE_MIN_MS, "startup-sidecars"),
      );
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

describe("canonical configured Gateway readiness", () => {
  it("normalizes core failures and advisories while preserving legacy fields", async () => {
    const gateway = failingSnapshot(["discord"]);
    const runtime = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: {
        errors: [{ id: "broken", activated: true, error: "load failed" }],
      },
    });

    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway: () => gateway,
      evaluateRuntime: async () => runtime,
    });

    expect(result.ready).toBe(false);
    expect(result.failing).toEqual(["discord"]);
    expect(result.failures).toEqual(["ChannelRuntimeUnavailable"]);
    expect(result.advisories).toEqual(["EventLoopStatusUnavailable", "PluginLoadFailures"]);
    expect(result.conditions?.map((condition) => condition.type)).toEqual([
      "GatewayStartupComplete",
      "GatewayAcceptingWork",
      "ChannelRuntimeReady",
      "EventLoopHealthy",
      "ConfigLoaded",
      "GatewayResponding",
      "PluginsLoaded",
    ]);
  });

  it("promotes selected canonical plugin failures without duplicating their condition", async () => {
    const runtime = buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: { errors: [{ id: "broken", activated: true, error: "load failed" }] },
    });

    const result = await evaluateConfiguredGatewayReadiness({
      config: {
        gateway: { readiness: { requiredCriteria: ["openclaw.plugins-loaded"] } },
      },
      identity: testReadinessIdentity(),
      evaluateGateway: () => readySnapshot() as ReadinessResult,
      evaluateRuntime: async () => runtime,
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toContain("PluginLoadFailures");
    expect(result.conditions.filter((entry) => entry.type === "PluginsLoaded")).toEqual([
      expect.objectContaining({ status: "False", requirement: "required" }),
    ]);
  });

  it("can require the canonical event-loop condition", async () => {
    const gateway = readySnapshot() as ReadinessResult;
    gateway.conditions = gateway.conditions?.map((condition) =>
      condition.type === "EventLoopHealthy"
        ? { ...condition, status: "False", reason: "EventLoopDegraded" }
        : condition,
    );

    const result = await evaluateConfiguredGatewayReadiness({
      config: {
        gateway: { readiness: { requiredCriteria: ["openclaw.event-loop-healthy"] } },
      },
      identity: testReadinessIdentity(),
      evaluateGateway: () => gateway,
      evaluateRuntime: async () =>
        buildRuntimeReadiness({ configLoaded: true, gateway: "responding" }),
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toContain("EventLoopDegraded");
    expect(result.conditions.find((entry) => entry.type === "EventLoopHealthy")).toMatchObject({
      status: "False",
      requirement: "required",
    });
  });
  it("returns a structured required failure when extended evaluation times out", async () => {
    const gateway = readySnapshot() as ReadinessResult;
    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway: () => gateway,
      evaluateRuntime: () => new Promise<never>(() => {}),
      failureContext: {
        conditions: buildHostingProfileConditions("container", {
          bind: "lan",
          bindHost: "0.0.0.0",
          port: 18789,
          authMode: "token",
          trustedProxySources: [],
          trustedProxyAllowLoopback: false,
        }).filter((condition) => condition.type === "ProfileSelected"),
        subjects: buildHostingProfileSubjects({ profile: "container", source: "config" }),
      },
      profileMetadata: {
        profileContractVersion: 1,
        profile: "container",
        profileSource: "config",
      },
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      ready: false,
      failing: ["ReadinessEvaluationTimedOut"],
      failures: ["ReadinessEvaluationTimedOut"],
      profileContractVersion: 1,
      profile: "container",
      profileSource: "config",
      identity: {
        subjects: expect.arrayContaining([
          expect.objectContaining({
            ref: "openclaw/hosting-profile/selected",
            id: "container",
          }),
        ]),
      },
    });
    expect(result.conditions).toContainEqual({
      type: "ReadinessEvaluationComplete",
      subjectRef: "openclaw/gateway/current",
      status: "Unknown",
      requirement: "required",
      reason: "ReadinessEvaluationTimedOut",
      message: "Readiness evaluation did not complete within its bounded deadline.",
    });
    expect(result.conditions?.[0]?.type).toBe("ReadinessEvaluationComplete");
  });

  it("retains selected canonical conditions when extended evaluation times out", async () => {
    const result = await evaluateConfiguredGatewayReadiness({
      config: {
        gateway: { readiness: { requiredCriteria: ["openclaw.plugins-loaded"] } },
      },
      identity: testReadinessIdentity(),
      evaluateGateway: () => readySnapshot() as ReadinessResult,
      evaluateRuntime: () => new Promise<never>(() => {}),
      timeoutMs: 5,
    });

    expect(result.ready).toBe(false);
    expect(result.conditions.find((entry) => entry.type === "PluginsLoaded")).toEqual({
      type: "PluginsLoaded",
      subjectRef: "openclaw/plugins/active",
      status: "Unknown",
      requirement: "required",
      reason: "CriterionEvaluationUnavailable",
      message: "Readiness criterion PluginsLoaded was selected but could not be evaluated.",
    });
  });

  it("redacts unexpected extended evaluation failures", async () => {
    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway: () => readySnapshot() as ReadinessResult,
      evaluateRuntime: async () => {
        throw new Error("secret backend path");
      },
    });

    expect(result.failures).toEqual(["ReadinessEvaluationFailed"]);
    expect(JSON.stringify(result)).not.toContain("secret backend path");
  });

  it("fails closed when merged conditions collide on subject and type", async () => {
    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway: () => readySnapshot() as ReadinessResult,
      evaluateRuntime: async () =>
        buildRuntimeReadiness({
          configLoaded: true,
          gateway: "responding",
          additionalConditions: [
            {
              type: "GatewayStartupComplete",
              subjectRef: "openclaw/gateway/current",
              status: "True",
              requirement: "required",
              reason: "DuplicateStartupCondition",
              message: "Duplicate startup condition.",
            },
          ],
        }),
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(["ReadinessEvaluationFailed"]);
    expect(result.conditions?.[0]?.type).toBe("ReadinessEvaluationComplete");
  });

  it("fails closed without rejecting when the core Gateway checker throws", async () => {
    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway: () => {
        throw new Error("unexpected core failure");
      },
      evaluateRuntime: async () =>
        buildRuntimeReadiness({ configLoaded: true, gateway: "responding" }),
    });

    expect(result).toMatchObject({
      ready: false,
      uptimeMs: 0,
      failing: ["ReadinessEvaluationFailed"],
      failures: ["ReadinessEvaluationFailed"],
    });
    expect(result.conditions?.[0]?.type).toBe("ReadinessEvaluationComplete");
    expect(JSON.stringify(result)).not.toContain("unexpected core failure");
  });
});

describe("evaluateConfiguredGatewayReadiness", () => {
  it("projects the legacy Gateway checker into a canonical result when unconfigured", async () => {
    const gateway = readySnapshot() as ReadinessResult;
    const evaluateGateway = vi.fn(() => gateway);
    const evaluateRuntime = vi.fn(async () => {
      throw new Error("extended evaluator should not run");
    });

    const result = await evaluateConfiguredGatewayReadiness({
      config: {},
      identity: testReadinessIdentity(),
      evaluateGateway,
      evaluateRuntime,
    });

    expect(result.ready).toBe(gateway.ready);
    expect(result.contractVersion).toBe(1);
    expect(result.identity.producerRef).toBe("openclaw/gateway/current");
    expect(result.failing).toEqual(gateway.failing);
    expect(evaluateGateway).toHaveBeenCalledTimes(1);
    expect(evaluateRuntime).not.toHaveBeenCalled();
  });

  it("fails closed when the unconfigured legacy checker throws", async () => {
    const evaluateRuntime = vi.fn(async () =>
      buildRuntimeReadiness({ configLoaded: true, gateway: "responding" }),
    );

    const result = await evaluateConfiguredGatewayReadiness({
      config: {},
      identity: testReadinessIdentity(),
      evaluateGateway: () => {
        throw new Error("legacy checker failed");
      },
      evaluateRuntime,
    });
    expect(result).toMatchObject({
      contractVersion: 1,
      ready: false,
      failures: ["ReadinessEvaluationFailed"],
    });
    expect(evaluateRuntime).not.toHaveBeenCalled();
  });

  it("opts into fail-closed canonical evaluation when the section is present", async () => {
    const result = await evaluateConfiguredGatewayReadiness({
      config: { gateway: { readiness: {} } },
      identity: testReadinessIdentity(),
      evaluateGateway: () => readySnapshot() as ReadinessResult,
      evaluateRuntime: async () => {
        throw new Error("runtime evaluation failed");
      },
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(["ReadinessEvaluationFailed"]);
  });

  it("allows a selected hosting profile to opt into canonical evaluation", async () => {
    const result = await evaluateConfiguredGatewayReadiness({
      identity: testReadinessIdentity(),
      config: {},
      canonicalEvaluationEnabled: true,
      evaluateGateway: () => readySnapshot() as ReadinessResult,
      evaluateRuntime: async () => {
        throw new Error("profile runtime evaluation failed");
      },
      failureContext: {
        conditions: buildHostingProfileConditions("container", {
          bind: "lan",
          bindHost: "0.0.0.0",
          port: 18789,
          authMode: "token",
          trustedProxySources: [],
          trustedProxyAllowLoopback: false,
        }).filter((condition) => condition.type === "ProfileSelected"),
        subjects: buildHostingProfileSubjects({ profile: "container", source: "environment" }),
      },
      profileMetadata: {
        profileContractVersion: 1,
        profile: "container",
        profileSource: "environment",
      },
    });

    expect(result).toMatchObject({
      ready: false,
      failures: ["ReadinessEvaluationFailed"],
      profileContractVersion: 1,
      profile: "container",
      profileSource: "environment",
      identity: {
        subjects: expect.arrayContaining([
          expect.objectContaining({ ref: "openclaw/hosting-profile/selected", id: "container" }),
        ]),
      },
    });
  });
});
