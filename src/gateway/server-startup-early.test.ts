import { beforeEach, describe, expect, it, vi } from "vitest";

type StartGatewayDiscovery = typeof import("./server-discovery-runtime.js").startGatewayDiscovery;

const mocks = vi.hoisted(() => ({
  getMachineDisplayName: vi.fn(async () => "Test Machine"),
  startGatewayDiscovery: vi.fn<StartGatewayDiscovery>(async () => ({ bonjourStop: null })),
  setSkillsRemoteRegistry: vi.fn(),
  primeRemoteSkillsCache: vi.fn(),
  refreshRemoteBinsForConnectedNodes: vi.fn(),
  registerSkillsChangeListener: vi.fn(),
  skillsChangeUnsub: vi.fn(),
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

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  configureTaskRegistryMaintenance: mocks.configureTaskRegistryMaintenance,
  startTaskRegistryMaintenance: mocks.startTaskRegistryMaintenance,
  getInspectableActiveTaskRestartBlockers: mocks.getInspectableActiveTaskRestartBlockers,
}));

import { createChatRunState } from "./server-chat-state.js";
import { startGatewayEarlyRuntime, startGatewayPluginDiscovery } from "./server-startup-early.js";

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
    mocks.configureTaskRegistryMaintenance.mockReset();
    mocks.startTaskRegistryMaintenance.mockReset();
    mocks.getInspectableActiveTaskRestartBlockers.mockReset();
    mocks.getInspectableActiveTaskRestartBlockers.mockReturnValue([]);
  });

  it("does not eagerly start the MCP loopback server", async () => {
    const chatRunState = createChatRunState();
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      gatewayDirectReachable: false,
      tailscaleMode: "off" as never,
      log: {
        info: () => {},
        warn: () => {},
      },
      logDiscovery: {
        info: () => {},
        warn: () => {},
      },
      nodeRegistry: {} as never,
      broadcast: () => {},
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: async () => ({}) as never,
      logHealth: { error: () => {} },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      removeChatRun: () => undefined,
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      getRuntimeConfig: () => ({}) as never,
    });

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });

  it("wires non-minimal skills runtime through lazy startup imports", async () => {
    const chatRunState = createChatRunState();
    const nodeRegistry = { node: { id: "node" } };
    mocks.getInspectableActiveTaskRestartBlockers.mockReturnValueOnce(["active-task"]);

    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      gatewayDirectReachable: false,
      tailscaleMode: "off" as never,
      log: {
        info: () => {},
        warn: () => {},
      },
      logDiscovery: {
        info: () => {},
        warn: () => {},
      },
      nodeRegistry: nodeRegistry as never,
      broadcast: () => {},
      nodeSendToAllSubscribed: () => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: async () => ({}) as never,
      logHealth: { error: () => {} },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      removeChatRun: () => undefined,
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      getRuntimeConfig: () => ({}) as never,
    });

    expect(mocks.setSkillsRemoteRegistry).toHaveBeenCalledWith(nodeRegistry);
    expect(mocks.primeRemoteSkillsCache).toHaveBeenCalledTimes(1);
    expect(mocks.configureTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.startTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.registerSkillsChangeListener).toHaveBeenCalledTimes(1);
    expect(earlyRuntime.getActiveTaskCount()).toBe(1);

    earlyRuntime.skillsChangeUnsub();
    expect(mocks.skillsChangeUnsub).toHaveBeenCalledTimes(1);
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
