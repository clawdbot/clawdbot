/**
 * Gateway runtime state construction tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginSessionExtensionRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginChannelRegistry,
  pinActivePluginSessionExtensionRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  releasePinnedPluginSessionExtensionRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createRequest, createResponse, dispatchRequest } from "./server-http.test-harness.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

const mocks = vi.hoisted(() => ({
  listenGatewayHttpServer: vi.fn(
    async (_params: { bindHost: string; port?: number; retryEaddrinuse?: boolean }) => {},
  ),
  resolveGatewayListenHosts: vi.fn(async (_bindHost: string) => ["127.0.0.1"]),
}));

vi.mock("./server/http-listen.js", () => ({
  listenGatewayHttpServer: mocks.listenGatewayHttpServer,
}));

vi.mock("./net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./net.js")>();
  return { ...actual, resolveGatewayListenHosts: mocks.resolveGatewayListenHosts };
});

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: "exact",
    handler: () => true,
    pluginId: "demo",
    source: "test",
  });
  return registry;
}

describe("createGatewayRuntimeState", () => {
  beforeEach(() => {
    mocks.listenGatewayHttpServer.mockReset();
    mocks.listenGatewayHttpServer.mockResolvedValue(undefined);
    mocks.resolveGatewayListenHosts.mockReset();
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1"]);
  });

  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    releasePinnedPluginChannelRegistry();
    releasePinnedPluginSessionExtensionRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("releases post-bootstrap repinned plugin registries on cleanup", async () => {
    const startupRegistry = createRegistryWithRoute("/startup");
    const loadedRegistry = createRegistryWithRoute("/loaded");
    const fallbackRegistry = createRegistryWithRoute("/fallback");

    setActivePluginRegistry(startupRegistry);
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry);

    pinActivePluginHttpRouteRegistry(loadedRegistry);
    pinActivePluginSessionExtensionRegistry(loadedRegistry);
    pinActivePluginChannelRegistry(loadedRegistry);
    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(loadedRegistry);
    expect(getActivePluginSessionExtensionRegistry()).toBe(loadedRegistry);
    expect(getActivePluginChannelRegistry()).toBe(loadedRegistry);

    runtimeState.releasePluginRouteRegistry();

    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(startupRegistry);
    expect(getActivePluginSessionExtensionRegistry()).toBe(startupRegistry);
    expect(getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  it("avoids the wrapper registry lookup after the plugin request handler loads", async () => {
    const startupRegistry = createRegistryWithRoute("/plugin");
    startupRegistry.httpRoutes[0]!.handler = (_req, res) => {
      res.end("startup");
      return true;
    };
    const repinnedRegistry = createRegistryWithRoute("/plugin");
    repinnedRegistry.httpRoutes[0]!.handler = (_req, res) => {
      res.end("repinned");
      return true;
    };
    let activeRegistry = startupRegistry;
    const getPluginRouteRegistry = vi.fn(() => activeRegistry);
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry, {
      getPluginRouteRegistry,
    });

    const firstResponse = createResponse();
    await dispatchRequest(
      runtimeState.httpServer,
      createRequest({ path: "/plugin" }),
      firstResponse.res,
    );
    const firstRequestLookups = getPluginRouteRegistry.mock.calls.length;

    activeRegistry = createEmptyPluginRegistry();
    const removedRouteResponse = createResponse();
    await dispatchRequest(
      runtimeState.httpServer,
      createRequest({ path: "/plugin" }),
      removedRouteResponse.res,
    );
    const removedRouteLookups = getPluginRouteRegistry.mock.calls.length;

    activeRegistry = repinnedRegistry;
    const repinnedRouteResponse = createResponse();
    await dispatchRequest(
      runtimeState.httpServer,
      createRequest({ path: "/plugin" }),
      repinnedRouteResponse.res,
    );

    expect(firstResponse.getBody()).toBe("startup");
    expect(removedRouteResponse.res.statusCode).toBe(404);
    expect(repinnedRouteResponse.getBody()).toBe("repinned");
    expect(firstRequestLookups).toBe(4);
    expect(removedRouteLookups - firstRequestLookups).toBe(3);
    expect(getPluginRouteRegistry.mock.calls.length - removedRouteLookups).toBe(3);
  });

  it("fails startup when the required IPv4 loopback alias cannot bind", async () => {
    const warn = vi.fn();
    mocks.resolveGatewayListenHosts.mockResolvedValue(["100.64.0.1", "127.0.0.1"]);
    mocks.listenGatewayHttpServer.mockImplementation(async ({ bindHost }) => {
      if (bindHost === "127.0.0.1") {
        throw new Error("loopback occupied");
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      bindHost: "100.64.0.1",
      log: { info: () => {}, warn },
    });

    await expect(runtimeState.startListening()).rejects.toThrow("loopback occupied");
    await expect(runtimeState.startListening()).rejects.toThrow("loopback occupied");
    expect(mocks.listenGatewayHttpServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bindHost: "127.0.0.1", retryEaddrinuse: false }),
    );
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(runtimeState.httpBindHosts).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("failed to bind loopback alias"));
  });

  it("keeps the optional IPv6 loopback alias non-fatal", async () => {
    const warn = vi.fn();
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1", "::1"]);
    mocks.listenGatewayHttpServer.mockImplementation(async ({ bindHost }) => {
      if (bindHost === "::1") {
        throw new Error("IPv6 unavailable");
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      log: { info: () => {}, warn },
      port: 18789,
    });

    await expect(runtimeState.startListening()).resolves.toBeUndefined();
    expect(runtimeState.httpBindHosts).toEqual(["127.0.0.1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to bind loopback alias ::1"));
  });

  it("starts the shared sandbox host on a dedicated adjacent-port origin", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      cfg: { mcp: { apps: { enabled: true } } },
      port: 18789,
    });

    expect(runtimeState.getMcpAppSandboxPort()).toBeUndefined();
    await runtimeState.startListening();

    expect(runtimeState.getMcpAppSandboxPort()).toBe(18790);
    expect(runtimeState.httpServers).toHaveLength(2);
    expect(mocks.listenGatewayHttpServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bindHost: "127.0.0.1", port: 18789 }),
    );
    expect(mocks.listenGatewayHttpServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bindHost: "127.0.0.1",
        port: 18790,
        retryEaddrinuse: false,
      }),
    );
  });

  it("starts the shared sandbox host lazily when MCP Apps are disabled", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
    });

    await runtimeState.startListening();

    expect(runtimeState.getMcpAppSandboxPort()).toBeUndefined();
    expect(runtimeState.httpServers).toHaveLength(1);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(1);

    await expect(runtimeState.ensureSandboxHostPort()).resolves.toBe(18790);
    expect(runtimeState.getMcpAppSandboxPort()).toBe(18790);
    expect(runtimeState.httpServers).toHaveLength(2);
    expect(mocks.listenGatewayHttpServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ bindHost: "127.0.0.1", port: 18790 }),
    );
  });

  it("waits for every gateway bind host before freezing lazy sandbox listeners", async () => {
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1", "::1"]);
    let releaseSecondBind: () => void = () => {};
    const secondBind = new Promise<void>((resolve) => {
      releaseSecondBind = resolve;
    });
    mocks.listenGatewayHttpServer.mockImplementation(async ({ bindHost, port }) => {
      if (bindHost === "::1" && port === 18789) {
        await secondBind;
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
    });

    const starting = runtimeState.startListening();
    await vi.waitFor(() =>
      expect(mocks.listenGatewayHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({ bindHost: "::1", port: 18789 }),
      ),
    );
    const ensuring = runtimeState.ensureSandboxHostPort();
    await Promise.resolve();
    expect(mocks.listenGatewayHttpServer).not.toHaveBeenCalledWith(
      expect.objectContaining({ port: 18790 }),
    );

    releaseSecondBind();
    await starting;
    await expect(ensuring).resolves.toBe(18790);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({ bindHost: "127.0.0.1", port: 18790 }),
    );
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({ bindHost: "::1", port: 18790 }),
    );
  });

  it("retries lazy sandbox startup after an occupied port clears", async () => {
    let sandboxPortOccupied = true;
    mocks.listenGatewayHttpServer.mockImplementation(async ({ port }) => {
      if (port === 18790 && sandboxPortOccupied) {
        sandboxPortOccupied = false;
        throw new Error("sandbox port occupied");
      }
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
    });

    await expect(runtimeState.startListening()).resolves.toBeUndefined();
    await expect(runtimeState.ensureSandboxHostPort()).rejects.toThrow("sandbox port occupied");
    expect(runtimeState.httpServers).toHaveLength(1);

    await expect(runtimeState.ensureSandboxHostPort()).resolves.toBe(18790);
    expect(runtimeState.getMcpAppSandboxPort()).toBe(18790);
    expect(runtimeState.httpServers).toHaveLength(2);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(3);
  });
});
