// Health-state tests cover probe coalescing, sensitive snapshots, and broadcast version behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../health/types.js";

/**
 * Health-state cache tests covering coalescing, sensitive probes, and broadcasts.
 */
const { collectGatewayHealthSnapshotMock, getUpdateAvailableMock, getUpdateScheduleMock } =
  vi.hoisted(() => ({
    collectGatewayHealthSnapshotMock: vi.fn(),
    getUpdateAvailableMock: vi.fn(),
    getUpdateScheduleMock: vi.fn(),
  }));

vi.mock("../health/collector.js", () => ({
  collectGatewayHealthSnapshot: collectGatewayHealthSnapshotMock,
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateSchedule: getUpdateScheduleMock,
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

function createDeferredHealthSummary() {
  let resolve!: (summary: HealthSummary) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<HealthSummary>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadHealthState() {
  vi.resetModules();
  collectGatewayHealthSnapshotMock.mockReset();
  collectGatewayHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  getUpdateAvailableMock.mockReset();
  getUpdateAvailableMock.mockReturnValue(null);
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
  return await import("./health-state.js");
}

describe("buildGatewaySnapshot update metadata", () => {
  it.each([
    { role: "operator", scopes: ["operator.pairing"], allowed: false },
    { role: "node", scopes: ["operator.read", "operator.admin"], allowed: false },
    { role: "operator", scopes: ["operator.read"], allowed: true },
    { role: "operator", scopes: ["operator.write"], allowed: true },
    { role: "operator", scopes: ["operator.admin"], allowed: true },
  ])("resolves $role $scopes read access as $allowed", async ({ role, scopes, allowed }) => {
    const { canReadDetailedUpdateMetadata } = await import("../events.js");

    expect(canReadDetailedUpdateMetadata(role, scopes)).toBe(allowed);
  });

  it("omits the schedule and projects legacy availability without update detail access", async () => {
    const healthState = await loadHealthState();
    getUpdateAvailableMock.mockReturnValue({
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    });
    getUpdateScheduleMock.mockReturnValue({
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" },
    });

    const snapshot = healthState.buildGatewaySnapshot({ includeUpdateDetails: false });

    expect(snapshot.updateAvailable).toEqual({
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    });
    expect(snapshot.updateSchedule).toBeUndefined();
    expect(getUpdateScheduleMock).not.toHaveBeenCalled();
  });

  it("includes the full update availability and schedule with update detail access", async () => {
    const healthState = await loadHealthState();
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    };
    const updateSchedule = {
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" as const },
    };
    getUpdateAvailableMock.mockReturnValue(updateAvailable);
    getUpdateScheduleMock.mockReturnValue(updateSchedule);

    const snapshot = healthState.buildGatewaySnapshot({ includeUpdateDetails: true });

    expect(snapshot.updateAvailable).toBe(updateAvailable);
    expect(snapshot.updateSchedule).toBe(updateSchedule);
  });
});

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let a post-connect passive refresh absorb an explicit probe", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createDeferredHealthSummary();
    const probeDeferred = createDeferredHealthSummary();
    const passiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => passiveDeferred.promise)
      .mockImplementationOnce(() => probeDeferred.promise);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    const postConnectRefresh = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const explicitProbe = healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()).toMatchObject({
      audience: "public",
      probe: false,
      runtimeSnapshot: undefined,
    });
    expect(healthSnapshotCallArg(1)).toMatchObject({
      audience: "public",
      probe: true,
      runtimeSnapshot: undefined,
    });

    probeDeferred.resolve(probeSummary);
    await expect(explicitProbe).resolves.toBe(probeSummary);
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(probeSummary);

    passiveDeferred.resolve(passiveSummary);
    await expect(postConnectRefresh).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("publishes both generations in order when the passive refresh finishes first", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createDeferredHealthSummary();
    const probeDeferred = createDeferredHealthSummary();
    const passiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => passiveDeferred.promise)
      .mockImplementationOnce(() => probeDeferred.promise);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });

    passiveDeferred.resolve(passiveSummary);
    await expect(passive).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);

    probeDeferred.resolve(probeSummary);
    await expect(probe).resolves.toBe(probeSummary);
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 2);
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      passiveSummary,
      probeSummary,
    ]);
  });

  it("lets a passive refresh join an in-flight explicit probe", async () => {
    const healthState = await loadHealthState();
    const probeDeferred = createDeferredHealthSummary();
    const probeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockImplementationOnce(() => probeDeferred.promise);

    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    expect(healthSnapshotCallArg()?.probe).toBe(true);
    probeDeferred.resolve(probeSummary);
    await expect(Promise.all([probe, passive])).resolves.toEqual([probeSummary, probeSummary]);
  });

  it("coalesces concurrent explicit probe waiters", async () => {
    const healthState = await loadHealthState();
    const probeDeferred = createDeferredHealthSummary();
    const probeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockImplementationOnce(() => probeDeferred.promise);

    const first = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    probeDeferred.resolve(probeSummary);
    await expect(Promise.all([first, second])).resolves.toEqual([probeSummary, probeSummary]);
  });

  it("retains a displaced passive refresh after a faster probe settles", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createDeferredHealthSummary();
    const probeDeferred = createDeferredHealthSummary();
    const passiveSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => passiveDeferred.promise)
      .mockImplementationOnce(() => probeDeferred.promise);

    const firstPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    probeDeferred.reject(new Error("probe failed"));
    await expect(probe).rejects.toThrow("probe failed");

    const secondPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    passiveDeferred.resolve(passiveSummary);
    await expect(Promise.all([firstPassive, secondPassive])).resolves.toEqual([
      passiveSummary,
      passiveSummary,
    ]);
  });

  it("detaches an older passive refresh after a newer probe succeeds", async () => {
    const healthState = await loadHealthState();
    const firstPassiveDeferred = createDeferredHealthSummary();
    const probeDeferred = createDeferredHealthSummary();
    const secondPassiveDeferred = createDeferredHealthSummary();
    const firstPassiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    const secondPassiveSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => firstPassiveDeferred.promise)
      .mockImplementationOnce(() => probeDeferred.promise)
      .mockImplementationOnce(() => secondPassiveDeferred.promise);

    const firstPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    probeDeferred.resolve(probeSummary);
    await expect(probe).resolves.toBe(probeSummary);

    const secondPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    secondPassiveDeferred.resolve(secondPassiveSummary);
    await expect(secondPassive).resolves.toBe(secondPassiveSummary);
    expect(healthState.getHealthCache()).toBe(secondPassiveSummary);

    firstPassiveDeferred.resolve(firstPassiveSummary);
    await expect(firstPassive).resolves.toBe(firstPassiveSummary);
    expect(healthState.getHealthCache()).toBe(secondPassiveSummary);
  });

  it("passes event-loop health only when the hook returns a snapshot", async () => {
    const healthState = await loadHealthState();
    const eventLoop = {
      degraded: true,
      degradedSinceMs: 61_000,
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

  it("keeps strength-aware admin and public refresh lanes isolated", async () => {
    const healthState = await loadHealthState();
    const adminPassiveDeferred = createDeferredHealthSummary();
    const publicProbeDeferred = createDeferredHealthSummary();
    const adminProbeDeferred = createDeferredHealthSummary();
    const adminPassiveSummary = createHealthSummary();
    const publicProbeSummary = createHealthSummary();
    const adminProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => adminPassiveDeferred.promise)
      .mockImplementationOnce(() => publicProbeDeferred.promise)
      .mockImplementationOnce(() => adminProbeDeferred.promise);

    const adminPassive = healthState.refreshGatewayHealthSnapshot({
      probe: false,
      includeSensitive: true,
    });
    const publicProbe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const publicPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const adminProbe = healthState.refreshGatewayHealthSnapshot({
      probe: true,
      includeSensitive: true,
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthSnapshotCallArg()?.audience).toBe("admin");
    expect(healthSnapshotCallArg(1)?.audience).toBe("public");
    expect(healthSnapshotCallArg(2)?.audience).toBe("admin");
    expect(healthSnapshotCallArg()?.probe).toBe(false);
    expect(healthSnapshotCallArg(1)?.probe).toBe(true);
    expect(healthSnapshotCallArg(2)?.probe).toBe(true);

    adminProbeDeferred.resolve(adminProbeSummary);
    publicProbeDeferred.resolve(publicProbeSummary);
    adminPassiveDeferred.resolve(adminPassiveSummary);

    await expect(adminProbe).resolves.toBe(adminProbeSummary);
    await expect(Promise.all([publicProbe, publicPassive])).resolves.toEqual([
      publicProbeSummary,
      publicProbeSummary,
    ]);
    await expect(adminPassive).resolves.toBe(adminPassiveSummary);
    expect(healthState.getHealthCache()).toBe(publicProbeSummary);
  });

  it("recovers each strength lane after rejection without discarding an older success", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createDeferredHealthSummary();
    const probeDeferred = createDeferredHealthSummary();
    const passiveSummary = createHealthSummary();
    const recoveredProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => passiveDeferred.promise)
      .mockImplementationOnce(() => probeDeferred.promise)
      .mockResolvedValueOnce(recoveredProbeSummary);

    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    probeDeferred.reject(new Error("probe failed"));
    await expect(probe).rejects.toThrow("probe failed");

    passiveDeferred.resolve(passiveSummary);
    await expect(passive).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);

    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(
      recoveredProbeSummary,
    );
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthState.getHealthCache()).toBe(recoveredProbeSummary);
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
