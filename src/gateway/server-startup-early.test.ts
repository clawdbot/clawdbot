/**
 * Early gateway startup helper tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGatewayShutdownSteps } from "./server-shutdown.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

type StartGatewayDiscovery = typeof import("./server-discovery-runtime.js").startGatewayDiscovery;

const mocks = vi.hoisted(() => ({
  getMachineDisplayName: vi.fn(async () => "Test Machine"),
  startGatewayDiscovery: vi.fn<StartGatewayDiscovery>(async () => ({ bonjourStop: null })),
  setSkillsRemoteRegistry: vi.fn(),
  primeRemoteSkillsCache: vi.fn(),
  refreshRemoteBinsForConnectedNodes: vi.fn(),
  registerSkillsChangeListener: vi.fn(),
  closeSkillsWatchers: vi.fn(),
  skillsChangeUnsub: vi.fn(),
  ensureContextWindowCacheLoaded: vi.fn(),
  ensureTaskRuntimeStateReady: vi.fn(),
  configureTaskRegistryMaintenance: vi.fn(),
  startTaskRegistryMaintenance: vi.fn(),
  getInspectableActiveTaskRestartBlockers: vi.fn(),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: mocks.getMachineDisplayName,
}));

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: mocks.startGatewayDiscovery,
}));

vi.mock("../skills/runtime/remote.js", () => ({
  setSkillsRemoteRegistry: mocks.setSkillsRemoteRegistry,
  primeRemoteSkillsCache: mocks.primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes: mocks.refreshRemoteBinsForConnectedNodes,
}));

vi.mock("../skills/runtime/refresh.js", () => ({
  registerSkillsChangeListener: mocks.registerSkillsChangeListener,
  closeSkillsWatchers: mocks.closeSkillsWatchers,
}));

vi.mock("../agents/context.js", () => ({
  ensureContextWindowCacheLoaded: mocks.ensureContextWindowCacheLoaded,
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  ensureTaskRuntimeStateReady: mocks.ensureTaskRuntimeStateReady,
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  configureTaskRegistryMaintenance: mocks.configureTaskRegistryMaintenance,
  startTaskRegistryMaintenance: mocks.startTaskRegistryMaintenance,
  getInspectableActiveTaskRestartBlockers: mocks.getInspectableActiveTaskRestartBlockers,
}));

import { startGatewayEarlyRuntime, startGatewayPluginDiscovery } from "./server-startup-early.js";

type StartGatewayEarlyRuntimeInput = Parameters<typeof startGatewayEarlyRuntime>[0];

const log = {
  info: () => {},
  warn: () => {},
};

function earlyRuntimeInput(
  overrides: Partial<StartGatewayEarlyRuntimeInput> = {},
): StartGatewayEarlyRuntimeInput {
  const maintenanceState = createGatewayMaintenanceStateForTest({
    healthSummary: {} as never,
    healthVersion: 0,
    presenceVersion: 0,
  });
  return {
    minimalTestGateway: true,
    cfgAtStart: {} as never,
    port: 18_789,
    gatewayTls: { enabled: false },
    gatewayDirectReachable: false,
    tailscaleMode: "off" as never,
    log,
    logDiscovery: log,
    nodeRegistry: {} as never,
    swapBonjourStop: () => null,
    ...maintenanceState,
    skillsRefreshDelayMs: 30_000,
    getSkillsRefreshTimer: () => null,
    setSkillsRefreshTimer: () => {},
    getRuntimeConfig: () => ({}) as never,
    ...overrides,
  };
}

describe("startGatewayEarlyRuntime", () => {
  beforeEach(() => {
    mocks.getMachineDisplayName.mockClear();
    mocks.startGatewayDiscovery.mockClear();
    mocks.startGatewayDiscovery.mockResolvedValue({ bonjourStop: null });
    mocks.setSkillsRemoteRegistry.mockReset();
    mocks.primeRemoteSkillsCache.mockReset();
    mocks.refreshRemoteBinsForConnectedNodes.mockReset();
    mocks.registerSkillsChangeListener.mockReset();
    mocks.closeSkillsWatchers.mockReset();
    mocks.registerSkillsChangeListener.mockReturnValue(mocks.skillsChangeUnsub);
    mocks.skillsChangeUnsub.mockReset();
    mocks.ensureContextWindowCacheLoaded.mockReset();
    mocks.ensureContextWindowCacheLoaded.mockResolvedValue(undefined);
    mocks.ensureTaskRuntimeStateReady.mockReset();
    mocks.configureTaskRegistryMaintenance.mockReset();
    mocks.startTaskRegistryMaintenance.mockReset();
    mocks.getInspectableActiveTaskRestartBlockers.mockReset();
    mocks.getInspectableActiveTaskRestartBlockers.mockReturnValue([]);
  });

  it("does not eagerly start the MCP loopback server", async () => {
    const earlyRuntime = await startGatewayEarlyRuntime(earlyRuntimeInput());

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });

  it("wires non-minimal skills runtime through lazy startup imports", async () => {
    const nodeRegistry = { node: { id: "node" } };
    mocks.getInspectableActiveTaskRestartBlockers.mockReturnValueOnce(["active-task"]);

    const earlyRuntime = await startGatewayEarlyRuntime(
      earlyRuntimeInput({
        minimalTestGateway: false,
        nodeRegistry: nodeRegistry as never,
      }),
    );

    expect(mocks.setSkillsRemoteRegistry).toHaveBeenCalledWith(nodeRegistry);
    await Promise.resolve();
    expect(mocks.ensureContextWindowCacheLoaded).not.toHaveBeenCalled();
    expect(mocks.primeRemoteSkillsCache).toHaveBeenCalledTimes(1);
    expect(mocks.ensureTaskRuntimeStateReady).toHaveBeenCalledTimes(1);
    expect(mocks.configureTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.startTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.ensureTaskRuntimeStateReady.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      mocks.startGatewayDiscovery.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mocks.startGatewayDiscovery.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      mocks.startTaskRegistryMaintenance.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mocks.registerSkillsChangeListener).toHaveBeenCalledTimes(1);
    expect(earlyRuntime.getActiveTaskCount()).toBe(1);

    await earlyRuntime.skillsChangeUnsub();
    expect(mocks.skillsChangeUnsub).toHaveBeenCalledTimes(1);
    expect(mocks.closeSkillsWatchers).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "stops acquired discovery exactly once after later startup failure (cleanup rejects: %s)",
    async (cleanupRejects) => {
      const startupError = new Error("remote skills registry failed");
      const cleanupError = new Error("discovery cleanup failed");
      const stopDiscovery = vi.fn(async () => {
        if (cleanupRejects) {
          throw cleanupError;
        }
      });
      const owner: { current: (() => Promise<void>) | null } = { current: null };
      const swapBonjourStop = (next: typeof owner.current) => {
        const previous = owner.current;
        owner.current = next;
        return previous;
      };
      mocks.startGatewayDiscovery.mockResolvedValueOnce({ bonjourStop: stopDiscovery });
      mocks.setSkillsRemoteRegistry.mockImplementationOnce(() => {
        throw startupError;
      });
      const onCleanupError = vi.fn();

      const startup = startGatewayEarlyRuntime(
        earlyRuntimeInput({ minimalTestGateway: false, swapBonjourStop }),
      ).catch(async (error: unknown) => {
        await runGatewayShutdownSteps({
          steps: [
            { name: "discovery resident", run: async () => await swapBonjourStop(null)?.() },
            { name: "gateway close", run: async () => await swapBonjourStop(null)?.() },
          ],
          onError: onCleanupError,
        });
        throw error;
      });

      await expect(startup).rejects.toBe(startupError);
      expect(stopDiscovery).toHaveBeenCalledOnce();
      expect(owner.current).toBeNull();
      expect(onCleanupError).toHaveBeenCalledTimes(cleanupRejects ? 1 : 0);
    },
  );

  it("broadcasts remote-node skill invalidations to operator clients", async () => {
    const broadcast = vi.fn();

    await startGatewayEarlyRuntime(
      earlyRuntimeInput({
        minimalTestGateway: false,
        broadcast,
      }),
    );

    const listener = mocks.registerSkillsChangeListener.mock.calls.at(-1)?.[0] as
      | ((event: { reason: "remote-node" }) => void)
      | undefined;
    expect(listener).toBeDefined();

    listener?.({ reason: "remote-node" });

    expect(broadcast).toHaveBeenCalledWith("skills.changed", { reason: "remote-node" });
    expect(mocks.refreshRemoteBinsForConnectedNodes).not.toHaveBeenCalled();
  });

  it("broadcasts local skill changes after the coalesced remote-bin refresh", async () => {
    vi.useFakeTimers();
    const broadcast = vi.fn();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let finishRefresh: (() => void) | undefined;
    mocks.refreshRemoteBinsForConnectedNodes.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    try {
      await startGatewayEarlyRuntime(
        earlyRuntimeInput({
          minimalTestGateway: false,
          broadcast,
          getSkillsRefreshTimer: () => refreshTimer,
          setSkillsRefreshTimer: (timer) => {
            refreshTimer = timer;
          },
        }),
      );

      const listener = mocks.registerSkillsChangeListener.mock.calls.at(-1)?.[0] as
        | ((event: { reason: "watch" }) => void)
        | undefined;
      listener?.({ reason: "watch" });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mocks.refreshRemoteBinsForConnectedNodes).toHaveBeenCalledWith({});
      expect(broadcast).not.toHaveBeenCalled();

      finishRefresh?.();
      await Promise.resolve();
      expect(broadcast).toHaveBeenCalledWith("skills.changed", { reason: "watch" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails before discovery and task maintenance when task state cannot restore", async () => {
    const stopDiscovery = vi.fn(async () => {});
    const swapBonjourStop = vi.fn(() => null);
    mocks.startGatewayDiscovery.mockResolvedValue({ bonjourStop: stopDiscovery });
    mocks.ensureTaskRuntimeStateReady.mockImplementationOnce(() => {
      throw new Error("task-flow registry restore failed");
    });

    await expect(
      startGatewayEarlyRuntime(
        earlyRuntimeInput({
          minimalTestGateway: false,
          swapBonjourStop,
        }),
      ),
    ).rejects.toThrow("task-flow registry restore failed");

    expect(mocks.startGatewayDiscovery).not.toHaveBeenCalled();
    expect(swapBonjourStop).not.toHaveBeenCalled();
    expect(stopDiscovery).not.toHaveBeenCalled();
    expect(mocks.configureTaskRegistryMaintenance).not.toHaveBeenCalled();
    expect(mocks.startTaskRegistryMaintenance).not.toHaveBeenCalled();
  });

  it("starts discovery with the current plugin registry services", async () => {
    const stop = vi.fn(async () => {});
    mocks.startGatewayDiscovery.mockResolvedValueOnce({ bonjourStop: stop } as never);
    const service = {
      pluginId: "bonjour",
      service: { id: "bonjour", advertise: vi.fn() },
    };

    await expect(
      startGatewayPluginDiscovery({
        minimalTestGateway: false,
        cfgAtStart: { discovery: { mdns: { mode: "full" } } } as never,
        port: 19_001,
        gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
        gatewayDirectReachable: true,
        tailscaleMode: "serve" as never,
        logDiscovery: {
          info: () => {},
          warn: () => {},
        },
        pluginRegistry: {
          gatewayDiscoveryServices: [service],
        } as never,
      }),
    ).resolves.toBe(stop);

    const [discoveryParams] = mocks.startGatewayDiscovery.mock.calls.at(-1) ?? [];
    if (discoveryParams === undefined) {
      throw new Error("Expected gateway discovery to start");
    }
    expect(discoveryParams.machineDisplayName).toBe("Test Machine");
    expect(discoveryParams.port).toBe(19_001);
    expect(discoveryParams.gatewayTls).toEqual({ enabled: true, fingerprintSha256: "abc123" });
    expect(discoveryParams.gatewayDirectReachable).toBe(true);
    expect(discoveryParams.tailscaleMode).toBe("serve");
    expect(discoveryParams.mdnsMode).toBe("full");
    expect(discoveryParams.gatewayDiscoveryServices).toEqual([service]);
  });
});
