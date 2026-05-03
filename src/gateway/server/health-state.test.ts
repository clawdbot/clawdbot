import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";

const getHealthSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/health.js", () => ({
  getHealthSnapshot: getHealthSnapshotMock,
}));

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "/tmp/sessions.json",
      count: 0,
      recent: [],
    },
  };
}

async function loadHealthState() {
  vi.resetModules();
  getHealthSnapshotMock.mockReset();
  getHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  return await import("./health-state.js");
}

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps refreshes coalesced while preserving the first probe intent", async () => {
    const healthState = await loadHealthState();
    let resolveSnapshot: ((summary: HealthSummary) => void) | undefined;
    getHealthSnapshotMock.mockImplementation(
      () =>
        new Promise<HealthSummary>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const first = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getHealthSnapshotMock).toHaveBeenCalledWith({
      probe: false,
      includeSensitive: false,
      runtimeSnapshot: undefined,
    });
    expect(Object.hasOwn(getHealthSnapshotMock.mock.calls[0]?.[0] ?? {}, "eventLoop")).toBe(false);
    resolveSnapshot?.(createHealthSummary());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("passes event-loop health only when the hook returns a snapshot", async () => {
    const healthState = await loadHealthState();
    const eventLoop = {
      degraded: true,
      reasons: ["event_loop_delay" as const],
      intervalMs: 2_000,
      delayP99Ms: 1_500,
      delayMaxMs: 1_700,
      utilization: 0.2,
      cpuCoreRatio: 0.1,
    };

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getEventLoopHealth: () => eventLoop,
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getEventLoopHealth: () => undefined,
    });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(getHealthSnapshotMock.mock.calls[0]?.[0]?.eventLoop).toBe(eventLoop);
    expect(Object.hasOwn(getHealthSnapshotMock.mock.calls[1]?.[0] ?? {}, "eventLoop")).toBe(false);
  });

  it("captures runtime snapshots for completed refreshes and guards snapshot failures", async () => {
    const healthState = await loadHealthState();
    const runtimeSnapshot = {
      channels: { discord: { accountId: "default", connected: true } },
      channelAccounts: {},
    };

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getRuntimeSnapshot: () => runtimeSnapshot,
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getRuntimeSnapshot: () => {
        throw new Error("bad channel config");
      },
    });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(
      getHealthSnapshotMock.mock.calls
        .map((call) => call[0]?.probe)
        .toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    expect(getHealthSnapshotMock.mock.calls.map((call) => call[0]?.includeSensitive)).toEqual([
      false,
      false,
    ]);
    expect(getHealthSnapshotMock.mock.calls[0]?.[0]?.runtimeSnapshot).toBe(runtimeSnapshot);
    expect(getHealthSnapshotMock.mock.calls[1]?.[0]?.runtimeSnapshot).toBeUndefined();
  });

  it("does not cache or broadcast sensitive health refreshes", async () => {
    const healthState = await loadHealthState();
    const sensitiveSummary = createHealthSummary();
    const safeSummary = createHealthSummary();
    const broadcast = vi.fn();
    getHealthSnapshotMock
      .mockResolvedValueOnce(sensitiveSummary)
      .mockResolvedValueOnce(safeSummary);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    await healthState.refreshGatewayHealthSnapshot({ probe: true, includeSensitive: true });

    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.getHealthVersion()).toBe(version);
    expect(broadcast).not.toHaveBeenCalled();

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(healthState.getHealthCache()).toBe(safeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledWith(safeSummary);
  });

  it("keeps sensitive and public refreshes on separate in-flight promises", async () => {
    const healthState = await loadHealthState();
    const sensitiveSummary = createHealthSummary();
    const safeSummary = createHealthSummary();
    let resolveSensitive: (() => void) | undefined;
    let resolveSafe: (() => void) | undefined;
    getHealthSnapshotMock
      .mockImplementationOnce(
        () =>
          new Promise<HealthSummary>((resolve) => {
            resolveSensitive = () => resolve(sensitiveSummary);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<HealthSummary>((resolve) => {
            resolveSafe = () => resolve(safeSummary);
          }),
      );

    const sensitive = healthState.refreshGatewayHealthSnapshot({
      probe: true,
      includeSensitive: true,
    });
    const safe = healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(getHealthSnapshotMock.mock.calls[0]?.[0]?.includeSensitive).toBe(true);
    expect(getHealthSnapshotMock.mock.calls[1]?.[0]?.includeSensitive).toBe(false);

    resolveSensitive?.();
    resolveSafe?.();

    await expect(sensitive).resolves.toBe(sensitiveSummary);
    await expect(safe).resolves.toBe(safeSummary);
    expect(healthState.getHealthCache()).toBe(safeSummary);
  });
});
