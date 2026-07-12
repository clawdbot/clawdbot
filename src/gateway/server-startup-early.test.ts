/**
 * Early gateway startup helper tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

type StartGatewayDiscovery = typeof import("./server-discovery-runtime.js").startGatewayDiscovery;

const mocks = vi.hoisted(() => ({
  getMachineDisplayName: vi.fn(async () => "Test Machine"),
  startGatewayDiscovery: vi.fn<StartGatewayDiscovery>(async () => ({ bonjourStop: null })),
  setSkillsRemoteRegistry: vi.fn(),
  primeRemoteSkillsCache: vi.fn(),
  refreshRemoteBinsForConnectedNodes: vi.fn(),
  registerSkillsChangeListener: vi.fn(),
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
    expect(mocks.ensureContextWindowCacheLoaded).toHaveBeenCalledWith({});
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

    earlyRuntime.skillsChangeUnsub();
    expect(mocks.skillsChangeUnsub).toHaveBeenCalledTimes(1);
  });

  it("does not block gateway early runtime on context-window cache warmup", async () => {
    const pendingWarmup = new Promise<void>(() => {});
    mocks.ensureContextWindowCacheLoaded.mockReturnValueOnce(pendingWarmup);

    const earlyRuntime = await startGatewayEarlyRuntime(
      earlyRuntimeInput({
        minimalTestGateway: false,
        cfgAtStart: { agents: { defaults: { model: "openai/gpt-5.5" } } } as never,
      }),
    );

    await Promise.resolve();
    expect(mocks.ensureContextWindowCacheLoaded).toHaveBeenCalledTimes(1);
    expect(earlyRuntime).toHaveProperty("startMaintenance");
  });

  it("fails before discovery and task maintenance when task state cannot restore", async () => {
    mocks.ensureTaskRuntimeStateReady.mockImplementationOnce(() => {
      throw new Error("task-flow registry restore failed");
    });

    await expect(
      startGatewayEarlyRuntime(
        earlyRuntimeInput({
          minimalTestGateway: false,
        }),
      ),
    ).rejects.toThrow("task-flow registry restore failed");

    expect(mocks.startGatewayDiscovery).not.toHaveBeenCalled();
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
