import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";

type WriteWideAreaGatewayZone = typeof import("../infra/widearea-dns.js").writeWideAreaGatewayZone;
type ResolveWideAreaDiscoveryDomain =
  typeof import("../infra/widearea-dns.js").resolveWideAreaDiscoveryDomain;

const mocks = vi.hoisted(() => ({
  pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10"),
  pickPrimaryTailnetIPv6: vi.fn(() => undefined as string | undefined),
  resolveWideAreaDiscoveryDomain: vi.fn<ResolveWideAreaDiscoveryDomain>(() => "openclaw.internal."),
  writeWideAreaGatewayZone: vi.fn<WriteWideAreaGatewayZone>(async () => ({
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

function latestZoneParams(): Parameters<WriteWideAreaGatewayZone>[0] {
  const calls = mocks.writeWideAreaGatewayZone.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("Expected wide-area gateway zone to be written");
  }
  return call[0];
}

describe("startGatewayDiscovery", () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    vi.useRealTimers();
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
      gatewayDirectReachable: true,
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
      gatewayDirectReachable: true,
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

  it("omits invalid SSH discovery ports", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_SSH_PORT = "2222abc";

    const service = makeDiscoveryService({ id: "bonjour" });

    await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "serve",
      mdnsMode: "full",
      gatewayDiscoveryServices: [service],
      logDiscovery: makeLogs(),
    });

    expect(service.service.advertise).toHaveBeenCalledWith(
      expect.objectContaining({ sshPort: undefined }),
    );
  });

  it("omits out-of-range SSH discovery ports", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_SSH_PORT = "65536";

    const service = makeDiscoveryService({ id: "bonjour" });

    await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "serve",
      mdnsMode: "full",
      gatewayDiscoveryServices: [service],
      logDiscovery: makeLogs(),
    });

    expect(service.service.advertise).toHaveBeenCalledWith(
      expect.objectContaining({ sshPort: undefined }),
    );
  });

  it("continues startup when a local discovery service never settles", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "10";

    const service = makeDiscoveryService({
      id: "stuck-discovery",
      advertise: vi.fn(() => new Promise<void>(() => {})),
    });
    const logs = makeLogs();

    const resultPromise = startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      mdnsMode: "full",
      gatewayDiscoveryServices: [service],
      logDiscovery: logs,
    });

    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.bonjourStop).toBeTypeOf("function");
    await result.bonjourStop?.();
    expect(logs.warn.mock.calls).toEqual([
      [
        "gateway discovery service timed out after 10ms (stuck-discovery, plugin=stuck-discovery); continuing startup",
      ],
    ]);

    vi.useRealTimers();
  });

  it("uses the default discovery timeout for partial timeout env values", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "10abc";

    const service = makeDiscoveryService({
      id: "stuck-discovery",
      advertise: vi.fn(() => new Promise<void>(() => {})),
    });
    const logs = makeLogs();

    const resultPromise = startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      mdnsMode: "full",
      gatewayDiscoveryServices: [service],
      logDiscovery: logs,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(logs.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_990);
    const result = await resultPromise;

    expect(logs.warn.mock.calls).toEqual([
      [
        "gateway discovery service timed out after 5000ms (stuck-discovery, plugin=stuck-discovery); continuing startup",
      ],
    ]);
    await result.bonjourStop?.();
    vi.useRealTimers();
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
      gatewayDirectReachable: true,
      wideAreaDiscoveryEnabled: true,
      wideAreaDiscoveryDomain: "openclaw.internal.",
      tailscaleMode: "serve",
      mdnsMode: "off",
      gatewayDiscoveryServices: [service],
      logDiscovery: logs,
    });

    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(mocks.resolveTailnetDnsHint).toHaveBeenCalledWith({ enabled: true });
    const zoneParams = latestZoneParams();
    expect(zoneParams.domain).toBe("openclaw.internal.");
    expect(zoneParams.gatewayPort).toBe(18789);
    expect(zoneParams.gatewayDirectReachable).toBe(true);
    expect(zoneParams.displayName).toBe("Lab Mac (OpenClaw)");
    expect(zoneParams.tailnetIPv4).toBe("100.64.0.10");
    expect(zoneParams.tailnetDns).toBe("gateway.tailnet.example.ts.net");
    expect(logs.info.mock.calls).toEqual([
      ["wide-area DNS-SD updated (openclaw.internal. → /tmp/openclaw.internal.db)"],
    ]);
    expect(result.bonjourStop).toBeNull();
  });

  it("logs a warning and skips zone writes when wide-area config is invalid", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    // Drive the gateway through the REAL resolver so an invalid configured
    // domain flows through normalizeWideAreaDomain → caught → null, exactly
    // as it does at runtime when an operator boots the gateway with
    // discovery.wideArea.domain set to a non-DNS string.
    const widearea = await vi.importActual<typeof import("../infra/widearea-dns.js")>(
      "../infra/widearea-dns.js",
    );
    mocks.resolveWideAreaDiscoveryDomain.mockImplementationOnce(
      widearea.resolveWideAreaDiscoveryDomain,
    );

    const logs = makeLogs();

    const result = await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      gatewayTls: { enabled: false },
      wideAreaDiscoveryEnabled: true,
      wideAreaDiscoveryDomain: "foo/bar",
      tailscaleMode: "serve",
      mdnsMode: "off",
      gatewayDiscoveryServices: [],
      logDiscovery: logs,
    });

    expect(mocks.writeWideAreaGatewayZone).not.toHaveBeenCalled();
    expect(logs.warn.mock.calls).toEqual([
      [
        "discovery.wideArea.enabled is true, but no domain was configured; set discovery.wideArea.domain to enable unicast DNS-SD",
      ],
    ]);
    expect(result.bonjourStop).toBeNull();
  });

  it("omits the CLI path from wide-area DNS-SD in minimal mode", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    const logs = makeLogs();

    await startGatewayDiscovery({
      machineDisplayName: "Lab Mac",
      port: 18789,
      gatewayTls: { enabled: false },
      wideAreaDiscoveryEnabled: true,
      wideAreaDiscoveryDomain: "openclaw.internal.",
      tailscaleMode: "serve",
      mdnsMode: "minimal",
      gatewayDiscoveryServices: [],
      logDiscovery: logs,
    });

    const zoneParams = latestZoneParams();
    expect(zoneParams.cliPath).toBeUndefined();
    expect(mocks.resolveBonjourCliPath).not.toHaveBeenCalled();
  });
});
