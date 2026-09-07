// Gateway discovery runtime tests cover plugin discovery advertisements,
// wide-area DNS records, Bonjour naming, and shutdown cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureFullEnv } from "../test-utils/env.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

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

const createPluginOwner = () =>
  createGatewayPluginRuntimeGeneration({ getServices: () => null, setServices: () => {} });

const makeLogs = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});

function startDiscovery(overrides: Partial<Parameters<typeof startGatewayDiscovery>[0]>) {
  return startGatewayDiscovery({
    machineDisplayName: "Lab Mac",
    port: 18789,
    tailscaleMode: "off",
    pluginRuntimeClaim: createPluginOwner().currentClaim(),
    logDiscovery: makeLogs(),
    ...overrides,
  });
}

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

function useDevelopmentDiscoveryEnv() {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
}

async function expectSshPortOmitted(rawPort: string) {
  useDevelopmentDiscoveryEnv();
  process.env.OPENCLAW_SSH_PORT = rawPort;

  const service = makeDiscoveryService({ id: "bonjour" });

  await startDiscovery({
    discovery: { mdns: { mode: "full" } },
    tailscaleMode: "serve",
    gatewayDiscoveryServices: [service],
  });

  expect(service.service.advertise).toHaveBeenCalledWith(
    expect.objectContaining({ sshPort: undefined }),
  );
}

function startStuckDiscovery(timeoutMs: string) {
  vi.useFakeTimers();
  useDevelopmentDiscoveryEnv();
  process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = timeoutMs;

  const service = makeDiscoveryService({
    id: "stuck-discovery",
    advertise: vi.fn(() => new Promise<void>(() => {})),
  });
  const logs = makeLogs();

  const resultPromise = startDiscovery({
    discovery: { mdns: { mode: "full" } },
    gatewayDiscoveryServices: [service],
    logDiscovery: logs,
  });

  return { logs, resultPromise };
}

describe("startGatewayDiscovery", () => {
  const envSnapshot = captureFullEnv();

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot.restore();
    vi.clearAllMocks();
    mocks.resolveTailnetDnsHint.mockReset();
    mocks.resolveTailnetDnsHint.mockResolvedValue("gateway.tailnet.example.ts.net");
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

    const result = await startDiscovery({
      discovery: { mdns: { mode: "full" } },
      gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
      gatewayDirectReachable: true,
      tailscaleMode: "serve",
      gatewayDiscoveryServices: [bonjour, peer],
      logDiscovery: logs,
    });

    expect(bonjour.service.advertise).toHaveBeenCalledWith({
      machineDisplayName: "Lab Mac",
      gatewayPort: 18789,
      gatewayTlsEnabled: true,
      gatewayTlsFingerprintSha256: "abc123",
      gatewayDirectReachable: true,
      sshPort: 2222,
      tailnetDns: "gateway.tailnet.example.ts.net",
      cliPath: "/usr/local/bin/openclaw",
      minimal: false,
    });
    expect(peer.service.advertise).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();

    await result.stop();
    expect(stopped).toEqual(["peer", "bonjour"]);
  });

  it("omits invalid SSH discovery ports", async () => {
    await expectSshPortOmitted("2222abc");
  });

  it("omits out-of-range SSH discovery ports", async () => {
    await expectSshPortOmitted("65536");
  });

  it("continues startup when a local discovery service never settles", async () => {
    const { logs, resultPromise } = startStuckDiscovery("10");

    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    await result.stop();
    expect(logs.warn.mock.calls).toEqual([
      [
        "gateway discovery service timed out after 10ms (stuck-discovery, plugin=stuck-discovery); continuing startup",
      ],
    ]);

    vi.useRealTimers();
  });

  it("uses the default discovery timeout for partial timeout env values", async () => {
    const { logs, resultPromise } = startStuckDiscovery("10abc");

    await vi.advanceTimersByTimeAsync(10);
    expect(logs.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_990);
    const result = await resultPromise;

    expect(logs.warn.mock.calls).toEqual([
      [
        "gateway discovery service timed out after 5000ms (stuck-discovery, plugin=stuck-discovery); continuing startup",
      ],
    ]);
    await result.stop();
    vi.useRealTimers();
  });

  it("waits for delayed discovery when the configured timeout exceeds Node's timer range", async () => {
    useDevelopmentDiscoveryEnv();
    process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "2147483648";

    const stop = vi.fn();
    const service = makeDiscoveryService({
      id: "slow-discovery",
      advertise: vi.fn(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        return { stop };
      }),
    });
    const logs = makeLogs();

    const startedAt = Date.now();
    const result = await startDiscovery({
      discovery: { mdns: { mode: "full" } },
      gatewayDiscoveryServices: [service],
      logDiscovery: logs,
    });
    const elapsedMs = Date.now() - startedAt;

    await result.stop();

    expect(elapsedMs).toBeGreaterThanOrEqual(25);
    expect(logs.warn).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("skips local discovery services when mDNS mode is off", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    const service = makeDiscoveryService({ id: "bonjour" });
    const result = await startDiscovery({
      discovery: { mdns: { mode: "off" } },
      gatewayDiscoveryServices: [service],
    });

    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(mocks.resolveTailnetDnsHint).not.toHaveBeenCalled();
    await result.stop();
  });

  it("skips local discovery services for truthy OPENCLAW_DISABLE_BONJOUR values", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.OPENCLAW_DISABLE_BONJOUR = "yes";

    const service = makeDiscoveryService({ id: "bonjour" });
    const result = await startDiscovery({
      discovery: { mdns: { mode: "full" } },
      tailscaleMode: "serve",
      gatewayDiscoveryServices: [service],
    });

    expect(service.service.advertise).not.toHaveBeenCalled();
    await result.stop();
  });

  it("keeps wide-area DNS-SD publishing active when local discovery is off", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    const service = makeDiscoveryService({ id: "bonjour" });
    const logs = makeLogs();

    const result = await startDiscovery({
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "openclaw.internal." } },
      gatewayTls: { enabled: false },
      gatewayDirectReachable: true,
      tailscaleMode: "serve",
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
    await result.stop();
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

    const result = await startDiscovery({
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "foo/bar" } },
      gatewayTls: { enabled: false },
      tailscaleMode: "serve",
      gatewayDiscoveryServices: [],
      logDiscovery: logs,
    });

    expect(mocks.writeWideAreaGatewayZone).not.toHaveBeenCalled();
    expect(logs.warn.mock.calls).toEqual([
      [
        "wide-area discovery was requested without a domain; set discovery.wideArea.domain to enable unicast DNS-SD",
      ],
    ]);
    await result.stop();
  });

  it("omits the CLI path from wide-area DNS-SD in minimal mode", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;

    const logs = makeLogs();

    await startDiscovery({
      discovery: { mdns: { mode: "minimal" }, wideArea: { domain: "openclaw.internal." } },
      gatewayTls: { enabled: false },
      tailscaleMode: "serve",
      gatewayDiscoveryServices: [],
      logDiscovery: logs,
    });

    const zoneParams = latestZoneParams();
    expect(zoneParams.cliPath).toBeUndefined();
    expect(mocks.resolveBonjourCliPath).not.toHaveBeenCalled();
  });

  it("replaces advertisements and wide-area metadata across live mode changes", async () => {
    useDevelopmentDiscoveryEnv();
    process.env.OPENCLAW_SSH_PORT = "2222";
    const stop = vi.fn();
    const service = makeDiscoveryService({ id: "bonjour", stop });
    const discovery = await startDiscovery({
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "openclaw.internal." } },
      gatewayTls: { enabled: true, fingerprintSha256: "fingerprint" },
      gatewayDirectReachable: true,
      tailscaleMode: "serve",
      gatewayDiscoveryServices: [service],
    });

    for (const mode of ["minimal", "full", "minimal", "off"] as const) {
      await discovery.update({ mdnsMode: mode });
      const full = mode === "full";
      expect(latestZoneParams()).toMatchObject({
        domain: "openclaw.internal.",
        gatewayPort: 18789,
        gatewayTlsEnabled: true,
        gatewayTlsFingerprintSha256: "fingerprint",
        gatewayDirectReachable: true,
        cliPath: full ? "/usr/local/bin/openclaw" : undefined,
        sshPort: full ? 2222 : undefined,
      });
    }
    expect(service.service.advertise).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(service.service.advertise).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ minimal: false, sshPort: 2222 }),
    );
    await discovery.update({ mdnsMode: undefined });
    expect(service.service.advertise).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimal: true, cliPath: undefined, sshPort: undefined }),
    );
    await discovery.update({ mdnsMode: "minimal" });
    expect(service.service.advertise).toHaveBeenCalledTimes(4);
    await discovery.stop();
    await discovery.stop();
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it("keeps the live mode when the loaded discovery service owner changes", async () => {
    useDevelopmentDiscoveryEnv();
    const oldStop = vi.fn();
    const oldService = makeDiscoveryService({ id: "old", stop: oldStop });
    const newStop = vi.fn();
    const newService = makeDiscoveryService({ id: "new", stop: newStop });
    const discovery = await startDiscovery({
      discovery: { mdns: { mode: "full" } },
      gatewayDiscoveryServices: [oldService],
    });
    await discovery.update({ mdnsMode: "minimal" });
    await discovery.update({ gatewayDiscoveryServices: [newService] });
    expect(oldStop).toHaveBeenCalledTimes(2);
    expect(newService.service.advertise).toHaveBeenCalledWith(
      expect.objectContaining({ minimal: true }),
    );
    await discovery.update({ mdnsMode: "full" });
    expect(oldService.service.advertise).toHaveBeenCalledTimes(2);
    expect(newService.service.advertise).toHaveBeenCalledTimes(2);
    await discovery.stop();
    expect(newStop).toHaveBeenCalledTimes(2);
  });

  it.each(["off", "shutdown"] as const)(
    "stops a timed-out advertiser that finishes after %s without resurrecting it",
    async (action) => {
      useDevelopmentDiscoveryEnv();
      vi.useFakeTimers();
      process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "10";
      const advertised = createDeferredCore<{ stop: () => void }>();
      const stop = vi.fn();
      const discoveryPromise = startDiscovery({
        gatewayDiscoveryServices: [
          makeDiscoveryService({ id: "late", advertise: () => advertised.promise }),
        ],
      });
      await vi.advanceTimersByTimeAsync(10);
      const discovery = await discoveryPromise;
      if (action === "off") {
        await discovery.update({ mdnsMode: "off" });
      } else {
        await discovery.stop();
      }
      advertised.resolve({ stop });
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledOnce();
      await discovery.stop();
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { action: "replacement", olderGeneration: false, boundary: "stop" },
    { action: "shutdown", olderGeneration: false, boundary: "stop" },
    { action: "replacement", olderGeneration: true, boundary: "stop" },
    { action: "shutdown", olderGeneration: true, boundary: "stop" },
    { action: "replacement", olderGeneration: false, boundary: "DNS" },
    { action: "off", olderGeneration: false, boundary: "DNS" },
    { action: "replacement", olderGeneration: false, boundary: "advertise" },
  ] as const)(
    "drains cleanup acquired during $boundary before $action (older generation: $olderGeneration)",
    async ({ action, olderGeneration, boundary }) => {
      useDevelopmentDiscoveryEnv();
      vi.useFakeTimers();
      process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "10";
      const lateAdvertisement = createDeferredCore<{ stop: () => Promise<void> }>();
      const activeStopping = createDeferredCore();
      const activeStopped = createDeferredCore();
      const metadata = createDeferredCore<string>();
      const lateStopped = createDeferredCore();
      const stopLate = vi.fn(() => lateStopped.promise);
      const next = makeDiscoveryService({ id: "next" });
      const pause = () => {
        activeStopping.resolve();
        return activeStopped.promise;
      };
      const active = makeDiscoveryService({
        id: "active",
        ...(boundary === "advertise" ? { advertise: pause } : { stop: pause }),
      });
      const discoveryPromise = startDiscovery({
        ...(action === "off" ? { discovery: { wideArea: { domain: "openclaw.internal." } } } : {}),
        gatewayDiscoveryServices: [
          makeDiscoveryService({ id: "late", advertise: () => lateAdvertisement.promise }),
          ...(boundary === "stop" && !olderGeneration ? [active] : []),
        ],
      });
      await vi.advanceTimersByTimeAsync(10);
      const discovery = await discoveryPromise;
      if (olderGeneration) {
        await discovery.update({ gatewayDiscoveryServices: [active] });
      }
      if (boundary === "DNS") {
        mocks.resolveTailnetDnsHint.mockImplementationOnce(() => {
          activeStopping.resolve();
          return metadata.promise;
        });
      }
      let settled = false;
      const transition = (
        action === "replacement"
          ? discovery.update({
              gatewayDiscoveryServices: boundary === "advertise" ? [active, next] : [next],
            })
          : action === "off"
            ? discovery.update({ mdnsMode: "off" })
            : discovery.stop()
      ).then(() => {
        settled = true;
      });
      try {
        await activeStopping.promise;
        lateAdvertisement.resolve({ stop: stopLate });
        await vi.advanceTimersByTimeAsync(0);
        activeStopped.resolve();
        metadata.resolve("gateway.tailnet.example.ts.net");
        await vi.advanceTimersByTimeAsync(0);

        expect(stopLate).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        expect(next.service.advertise).not.toHaveBeenCalled();

        lateStopped.resolve();
        await transition;
        expect(settled).toBe(true);
        expect(next.service.advertise).toHaveBeenCalledTimes(action === "replacement" ? 1 : 0);
      } finally {
        activeStopped.resolve();
        metadata.resolve("gateway.tailnet.example.ts.net");
        lateAdvertisement.resolve({ stop: stopLate });
        lateStopped.resolve();
        await transition;
        await discovery.stop();
      }
      expect(stopLate).toHaveBeenCalledOnce();
    },
  );

  it("fences pending metadata resolution before advertising or writing a stale zone", async () => {
    useDevelopmentDiscoveryEnv();
    const service = makeDiscoveryService({ id: "bonjour" });
    const discovery = await startDiscovery({
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "openclaw.internal." } },
      tailscaleMode: "serve",
      gatewayDiscoveryServices: [service],
    });
    const resolving = createDeferredCore();
    const dns = createDeferredCore<string>();
    mocks.resolveTailnetDnsHint.mockImplementationOnce(() => {
      resolving.resolve();
      return dns.promise;
    });
    const full = discovery.update({ mdnsMode: "full" });
    await resolving.promise;
    const off = discovery.update({ mdnsMode: "off" });
    dns.resolve("gateway.tailnet.example.ts.net");
    await Promise.all([full, off]);
    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(mocks.writeWideAreaGatewayZone).toHaveBeenCalledTimes(2);
    expect(latestZoneParams().cliPath).toBeUndefined();
    await discovery.stop();
    await discovery.update({ mdnsMode: "full" });
    expect(service.service.advertise).not.toHaveBeenCalled();
    expect(mocks.writeWideAreaGatewayZone).toHaveBeenCalledTimes(2);
  });

  it("takes each acquired cleanup once even when shutdown repeats", async () => {
    useDevelopmentDiscoveryEnv();
    const stop = vi.fn();
    const discovery = await startDiscovery({
      gatewayDiscoveryServices: [makeDiscoveryService({ id: "bonjour", stop })],
    });
    await discovery.stop();
    await discovery.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["reject", "replace", "shutdown"] as const)(
    "settles a plugin reservation after an in-flight advertisement: %s",
    async (action) => {
      useDevelopmentDiscoveryEnv();
      const pluginOwner = createPluginOwner();
      const started = createDeferredCore();
      const result = createDeferredCore<{ stop: () => void }>();
      const oldStop = vi.fn();
      const old = makeDiscoveryService({
        id: "old",
        advertise: vi.fn(() => {
          started.resolve();
          return result.promise;
        }),
      });
      const peer = makeDiscoveryService({ id: "peer" });
      const discovery = await startDiscovery({
        pluginRuntimeClaim: pluginOwner.currentClaim(),
        discovery: { mdns: { mode: "off" } },
      });
      await discovery.update({ gatewayDiscoveryServices: [old, peer] }, pluginOwner.currentClaim());
      const enabling = discovery.update({ mdnsMode: "full" });
      await started.promise;
      const replacement = pluginOwner.reserve();
      result.resolve({ stop: oldStop });
      await enabling;
      expect(oldStop).not.toHaveBeenCalled();
      expect(peer.service.advertise).not.toHaveBeenCalled();

      if (action === "reject") {
        replacement.reject();
        await vi.waitFor(() => expect(peer.service.advertise).toHaveBeenCalledOnce());
        expect(old.service.advertise).toHaveBeenCalledOnce();
        expect(oldStop).not.toHaveBeenCalled();
      } else if (action === "replace") {
        replacement.commit();
        // Runtime policy commits before the replacement registry is available.
        await discovery.update({ mdnsMode: "minimal" });
        expect(oldStop).toHaveBeenCalledOnce();
        expect(old.service.advertise).toHaveBeenCalledOnce();
        const next = makeDiscoveryService({ id: "next" });
        await discovery.update({ gatewayDiscoveryServices: [next] }, replacement.claim);
        expect(next.service.advertise).toHaveBeenCalledWith(
          expect.objectContaining({ minimal: true, cliPath: undefined, sshPort: undefined }),
        );
      } else {
        await discovery.stop();
        replacement.reject();
        await pluginOwner.currentClaim().waitForUnblocked();
      }
      await discovery.stop();
      expect(oldStop).toHaveBeenCalledOnce();
      if (action !== "reject") {
        expect(peer.service.advertise).not.toHaveBeenCalled();
      }
    },
  );

  it("retires the initial registry before a first mixed plugin and mode reload", async () => {
    useDevelopmentDiscoveryEnv();
    const pluginOwner = createPluginOwner();
    const oldStop = vi.fn();
    const old = makeDiscoveryService({ id: "old", stop: oldStop });
    const discovery = await startDiscovery({
      discovery: { mdns: { mode: "full" } },
      gatewayDiscoveryServices: [old],
      pluginRuntimeClaim: pluginOwner.currentClaim(),
    });
    try {
      const replacement = pluginOwner.reserve();
      replacement.commit();
      await discovery.update({ mdnsMode: "minimal" });
      expect(oldStop).toHaveBeenCalledOnce();
      expect(old.service.advertise).toHaveBeenCalledOnce();
      const next = makeDiscoveryService({ id: "next" });
      await discovery.update({ gatewayDiscoveryServices: [next] }, replacement.claim);
      expect(next.service.advertise).toHaveBeenCalledWith(
        expect.objectContaining({ minimal: true }),
      );
    } finally {
      await discovery.stop();
    }
  });
});
