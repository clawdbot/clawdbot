import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMachineDisplayName: vi.fn(async () => "Test Machine"),
  startGatewayDiscovery: vi.fn(async () => ({ bonjourStop: null })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: mocks.getMachineDisplayName,
}));

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: mocks.startGatewayDiscovery,
}));

import { startGatewayEarlyRuntime, startGatewayPluginDiscovery } from "./server-startup-early.js";

describe("startGatewayEarlyRuntime", () => {
  beforeEach(() => {
    mocks.getMachineDisplayName.mockClear();
    mocks.startGatewayDiscovery.mockClear();
    mocks.startGatewayDiscovery.mockResolvedValue({ bonjourStop: null });
  });

  it("does not eagerly start the MCP loopback server", async () => {
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
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
      chatRunState: { abortedRuns: new Map() },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      removeChatRun: () => {},
      agentRunSeq: new Map(),
      nodeSendToSession: () => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: () => {},
      getRuntimeConfig: () => ({}) as never,
    });

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
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

    expect(mocks.startGatewayDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        machineDisplayName: "Test Machine",
        port: 19_001,
        gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
        tailscaleMode: "serve",
        mdnsMode: "full",
        gatewayDiscoveryServices: [service],
      }),
    );
  });
});
