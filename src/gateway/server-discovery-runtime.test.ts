import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";

const mocks = vi.hoisted(() => ({
  pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10"),
  pickPrimaryTailnetIPv6: vi.fn(() => undefined as string | undefined),
  resolveWideAreaDiscoveryDomain: vi.fn(() => "openclaw.internal."),
  writeWideAreaGatewayZone: vi.fn(async () => ({
    changed: true,
    zonePath: "/tmp/openclaw.internal.db",
  })),
  formatBonjourInstanceName: vi.fn((name: string) => `${name} (OpenClaw)`),
  resolveBonjourCliPath: vi.fn(() => "/usr/local/bin/openclaw"),
  resolveTailnetDnsHint: vi.fn(async () => "gateway.tailnet.example.ts.net"),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6: mocks.pickPrimaryTailnetIPv6,
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: mocks.resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone: mocks.writeWideAreaGatewayZone,
}));

vi.mock("./server-discovery.js", () => ({
  formatBonjourInstanceName: mocks.formatBonjourInstanceName,
  resolveBonjourCliPath: mocks.resolveBonjourCliPath,
  resolveTailnetDnsHint: mocks.resolveTailnetDnsHint,
}));

const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");

const makeLogs = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});

const makeDiscoveryService = (params: {
  id: string;
  pluginId?: string;
  stop?: () => void | Promise<void>;
  advertise?: PluginGatewayDiscoveryServiceRegistration["service"]["advertise"];
}): PluginGatewayDiscoveryServiceRegistration => ({
  pluginId: params.pluginId ?? params.id,
  pluginName: params.pluginId ?? params.id,
  source: "test",
  service: {
    id: params.id,
    advertise: params.advertise ?? vi.fn(async () => ({ stop: params.stop })),
  },
});

describe("startGatewayDiscovery", () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      process.env[key] = value;
    }

    vi.clearAllMocks();
  });

  it("starts registered local discovery services with gateway advertisement context", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_SSH_PORT = "2222";

    const stopped: string[] = [];
    const bonjour = makeDiscoveryService({
      id: "bonjour",
      pluginId: "bonjour",
      stop: () => {
        stopped.push("bonjour");
      },
    });
    const peer = makeDiscoveryService({
      id: "peer-discovery",
      pluginId: "peer",
      stop: () => {
        stopped.push("peer");
      },
    });
    const logs = makeLogs();

    const result = await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
      canvasPort: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "serve",
      mdnsMode: "full",
      gatewayDiscoveryServices: [bonjour, peer],
      logDiscovery: logs,
    });

    expect(bonjour.service.advertise).toHaveBeenCalledWith({
      machineDisplayName: "Lab Mac",
      gatewayPort: 18789,
      gatewayTlsEnabled: true,
      gatewayTlsFingerprintSha256: "abc123",
      canvasPort: 18789,
      sshPort: 2222,
      tailnetDns: "gateway.tailnet.example.ts.net",
      cliPath: "/usr/local/bin/openclaw",
      minimal: false,
    });
    expect(peer.service.advertise).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();

    await result.bonjourStop?.();
    expect(stopped).toEqual(["peer", "bonjour"]);
  });

  it("skips local discovery services when mDNS mode is off", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    const service = makeDiscoveryService({ id: "bonjour" });
    const result = await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      mdnsMode: "off",
      gatewayDiscoveryServices: [service],
      logDiscovery: makeLogs(),
    });

    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(mocks.resolveTailnetDnsHint).not.toHaveBeenCalled();
    expect(result.bonjourStop).toBeNull();
  });

  it("skips local discovery services for truthy OPENCLAW_DISABLE_BONJOUR values", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_DISABLE_BONJOUR = "yes";

    const service = makeDiscoveryService({ id: "bonjour" });
    const result = await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "serve",
      mdnsMode: "full",
      gatewayDiscoveryServices: [service],
      logDiscovery: makeLogs(),
    });

    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(result.bonjourStop).toBeNull();
  });

  it("keeps wide-area DNS-SD publishing active when local discovery is off", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    const service = makeDiscoveryService({ id: "bonjour" });
    const logs = makeLogs();

    const result = await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      gatewayTls: { enabled: false },
      wideAreaDiscoveryEnabled: true,
      wideAreaDiscoveryDomain: "openclaw.internal.",
      tailscaleMode: "serve",
      mdnsMode: "off",
      gatewayDiscoveryServices: [service],
      logDiscovery: logs,
    });

    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(mocks.resolveTailnetDnsHint).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.writeWideAreaGatewayZone).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "openclaw.internal.",
        gatewayPort: 18789,
        displayName: "Lab Mac (OpenClaw)",
        tailnetIPv4: "100.64.0.10",
        tailnetDns: "gateway.tailnet.example.ts.net",
      }),
    );
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining("wide-area DNS-SD updated"));
    expect(result.bonjourStop).toBeNull();
  });
});
