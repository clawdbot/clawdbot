/**
 * Gateway runtime state construction tests.
 */
import { connect } from "node:net";
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

async function requestPluginUpgrade(port: number, path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: demo\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += String(chunk);
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error(`plugin upgrade timed out for ${path}`));
    });
  });
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

  it("delegates directly after lazily loading the plugin HTTP handler", async () => {
    const registry = createEmptyPluginRegistry();
    const routes = registry.httpRoutes;
    routes.push({
      path: "/demo",
      auth: "plugin",
      match: "exact",
      handler: (_req, res) => {
        res.statusCode = 204;
        res.end();
        return true;
      },
      pluginId: "demo",
      source: "test",
    });
    let routeReads = 0;
    Object.defineProperty(registry, "httpRoutes", {
      configurable: true,
      get: () => {
        routeReads++;
        return routes;
      },
    });
    const runtimeState = await createGatewayRuntimeStateForTest(registry);
    const server = runtimeState.httpServers[0];
    if (!server) {
      throw new Error("expected gateway HTTP server");
    }
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP gateway address");
    }
    try {
      routeReads = 0;
      await expect(fetch(`http://127.0.0.1:${address.port}/demo`)).resolves.toMatchObject({
        status: 204,
      });
      const firstRequestReads = routeReads;

      routeReads = 0;
      await expect(fetch(`http://127.0.0.1:${address.port}/demo`)).resolves.toMatchObject({
        status: 204,
      });

      expect(firstRequestReads).toBe(routeReads + 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a loaded plugin upgrade handler on the repinned route registry", async () => {
    const startupRegistry = createEmptyPluginRegistry();
    let runtimeRegistry = startupRegistry;
    let startupUpgradeCalls = 0;
    startupRegistry.httpRoutes.push({
      path: "/demo",
      auth: "plugin",
      match: "exact",
      handler: () => false,
      handleUpgrade: (_req, socket) => {
        startupUpgradeCalls++;
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: demo\r\n\r\n",
        );
        return true;
      },
      pluginId: "startup",
      source: "test",
    });
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry, {
      getPluginRouteRegistry: () => runtimeRegistry,
    });
    const server = runtimeState.httpServers[0];
    if (!server) {
      throw new Error("expected gateway HTTP server");
    }
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP gateway address");
    }
    try {
      await expect(requestPluginUpgrade(address.port, "/demo")).resolves.toContain(
        "101 Switching Protocols",
      );
      expect(startupUpgradeCalls).toBe(1);

      const replacementRegistry = createEmptyPluginRegistry();
      let replacementUpgradeCalls = 0;
      replacementRegistry.httpRoutes.push({
        path: "/demo",
        auth: "plugin",
        match: "exact",
        handler: () => false,
        handleUpgrade: (_req, socket) => {
          replacementUpgradeCalls++;
          socket.end(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: demo\r\n\r\n",
          );
          return true;
        },
        pluginId: "replacement",
        source: "test",
      });
      const emptyRegistry = createEmptyPluginRegistry();
      runtimeRegistry = emptyRegistry;
      pinActivePluginHttpRouteRegistry(emptyRegistry);
      await expect(requestPluginUpgrade(address.port, "/demo")).resolves.not.toContain(
        "101 Switching Protocols",
      );
      expect(startupUpgradeCalls).toBe(1);

      runtimeRegistry = replacementRegistry;
      pinActivePluginHttpRouteRegistry(replacementRegistry);

      await expect(requestPluginUpgrade(address.port, "/demo")).resolves.toContain(
        "101 Switching Protocols",
      );
      expect(startupUpgradeCalls).toBe(1);
      expect(replacementUpgradeCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
