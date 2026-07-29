// Health-state tests cover probe coalescing, sensitive snapshots, and broadcast version behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../health/types.js";

/**
 * Health-state cache tests covering coalescing, sensitive probes, and broadcasts.
 */
const collectGatewayHealthSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../health/collector.js", () => ({
  collectGatewayHealthSnapshot: collectGatewayHealthSnapshotMock,
}));

function healthSnapshotCallArg(index = 0) {
  return collectGatewayHealthSnapshotMock.mock.calls.at(index)?.at(0) as
    | {
        audience?: "public" | "admin";
        eventLoop?: unknown;
        probe?: boolean;
        runtimeSnapshot?: unknown;
        configReloadHotReloadStatus?: unknown;
      }
    | undefined;
}

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
  collectGatewayHealthSnapshotMock.mockReset();
  collectGatewayHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  return await import("./health-state.js");
}

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps refreshes coalesced while preserving the first probe intent", async () => {
    const healthState = await loadHealthState();
    let resolveSnapshot: ((summary: HealthSummary) => void) | undefined;
    collectGatewayHealthSnapshotMock.mockImplementation(
      () =>
        new Promise<HealthSummary>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const first = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledWith({
      audience: "public",
      probe: false,
      runtimeSnapshot: undefined,
    });
    expect(Object.hasOwn(healthSnapshotCallArg() ?? {}, "eventLoop")).toBe(false);
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

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.eventLoop).toBe(eventLoop);
    expect(Object.hasOwn(healthSnapshotCallArg(1) ?? {}, "eventLoop")).toBe(false);
  });

  it("passes the config reloader hot-reload status only when the hook returns one", async () => {
    const healthState = await loadHealthState();

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getConfigReloaderHotReloadStatus: () => "disabled",
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getConfigReloaderHotReloadStatus: () => undefined,
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.configReloadHotReloadStatus).toBe("disabled");
    expect(Object.hasOwn(healthSnapshotCallArg(1) ?? {}, "configReloadHotReloadStatus")).toBe(
      false,
    );
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

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(
      collectGatewayHealthSnapshotMock.mock.calls
        .map((_call, index) => healthSnapshotCallArg(index)?.probe)
        .toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    expect(
      collectGatewayHealthSnapshotMock.mock.calls.map(
        (_call, index) => healthSnapshotCallArg(index)?.audience,
      ),
    ).toEqual(["public", "public"]);
    expect(healthSnapshotCallArg()?.runtimeSnapshot).toBe(runtimeSnapshot);
    expect(healthSnapshotCallArg(1)?.runtimeSnapshot).toBeUndefined();
  });

  it("does not cache or broadcast sensitive health refreshes", async () => {
    const healthState = await loadHealthState();
    const sensitiveSummary = createHealthSummary();
    const safeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
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
    collectGatewayHealthSnapshotMock
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

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.audience).toBe("admin");
    expect(healthSnapshotCallArg(1)?.audience).toBe("public");

    resolveSensitive?.();
    resolveSafe?.();

    await expect(sensitive).resolves.toBe(sensitiveSummary);
    await expect(safe).resolves.toBe(safeSummary);
    expect(healthState.getHealthCache()).toBe(safeSummary);
  });

  it.each([
    { includeSensitive: false, label: "public" },
    { includeSensitive: true, label: "sensitive" },
  ])("releases the $label refresh lane after rejection", async ({ includeSensitive }) => {
    const healthState = await loadHealthState();
    const recovered = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockRejectedValueOnce(new Error("snapshot failed"))
      .mockResolvedValueOnce(recovered);

    await expect(
      healthState.refreshGatewayHealthSnapshot({ probe: false, includeSensitive }),
    ).rejects.toThrow("snapshot failed");
    await expect(
      healthState.refreshGatewayHealthSnapshot({ probe: false, includeSensitive }),
    ).resolves.toBe(recovered);

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
  });
});
