/**
 * Gateway runtime state construction tests.
 */
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

const mocks = vi.hoisted(() => ({
  listenGatewayHttpServer: vi.fn(
    async (_params: {
      httpServer: { address: () => unknown };
      bindHost: string;
      port?: number;
      retryEaddrinuse?: boolean;
      serviceName?: string;
    }) => {},
  ),
  resolveGatewayListenHosts: vi.fn(async (_bindHost: string) => ["127.0.0.1"]),
  pluginsHttpModuleLoaded: vi.fn(),
}));

vi.mock("./server/http-listen.js", () => ({
  listenGatewayHttpServer: mocks.listenGatewayHttpServer,
}));

vi.mock("./net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./net.js")>();
  return { ...actual, resolveGatewayListenHosts: mocks.resolveGatewayListenHosts };
});

vi.mock("./server/plugins-http.js", async (importOriginal) => {
  mocks.pluginsHttpModuleLoaded();
  return await importOriginal<typeof import("./server/plugins-http.js")>();
});

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
  const mockEphemeralAddress = (params: {
    httpServer: { address: () => unknown };
    port?: number;
    serviceName?: string;
  }) => {
    if (params.port !== 0) {
      return;
    }
    vi.spyOn(params.httpServer, "address").mockReturnValue({
      address: "127.0.0.1",
      family: "IPv4",
      port: params.serviceName === "Tailscale gateway ingress" ? 19_000 : 19_001,
    });
  };

  beforeEach(() => {
    mocks.listenGatewayHttpServer.mockReset();
    mocks.listenGatewayHttpServer.mockImplementation(async (params) => {
      mockEphemeralAddress(params);
    });
    mocks.resolveGatewayListenHosts.mockReset();
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1"]);
    mocks.pluginsHttpModuleLoaded.mockClear();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("yields between buffered WebSocket messages without reordering them", async () => {
    const runtimeState = await createGatewayRuntimeStateForTest();
    const server = runtimeState.httpServers[0]!;
    const events: string[] = [];
    let sentinel: ReturnType<typeof setImmediate> | undefined;
    const received = new Promise<void>((resolve, reject) => {
      runtimeState.wss.once("connection", (socket, req) => {
        socket.once("error", reject);
        socket.on("message", (data) => {
          const message = rawDataToString(data);
          events.push(message);
          if (message === "a") {
            sentinel = setImmediate(() => events.push("yield"));
          } else {
            resolve();
          }
        });
        // Feed both masked text frames as one receive chunk through the real
        // upgraded socket, independent of TCP packet splitting/coalescing.
        req.socket.pause();
        req.socket.unshift(
          Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x60, 0x81, 0x81, 1, 2, 3, 4, 0x63]),
        );
        req.socket.resume();
      });
    });
    let client: WebSocket | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP gateway address");
      }
      client = new WebSocket(`ws://127.0.0.1:${address.port}/`, {
        handshakeTimeout: 2_000,
      });
      await once(client, "open");
      await received;
      expect(events).toEqual(["a", "yield", "b"]);
    } finally {
      clearImmediate(sentinel);
      client?.terminate();
      for (const socket of runtimeState.wss.clients) {
        socket.terminate();
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      runtimeState.wss.close();
    }
  });

  it("keeps unrelated plugin HTTP routes cold for core HTTP and WebSocket requests", async () => {
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push({
      path: "/unrelated",
      auth: "plugin",
      match: "exact",
      handler: () => false,
      pluginId: "unrelated",
      source: "test",
    });
    const pluginUpgrade = vi.fn<NonNullable<(typeof registry.httpRoutes)[number]["handleUpgrade"]>>(
      (_req, socket) => {
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: demo\r\n\r\n",
        );
        return true;
      },
    );
    registry.httpRoutes.push({
      path: "/plugin",
      auth: "plugin",
      match: "exact",
      handler: () => false,
      handleUpgrade: pluginUpgrade,
      pluginId: "plugin",
      source: "test",
    });
    const getGatewayRequestContext = vi.fn();
    const runtimeState = await createGatewayRuntimeStateForTest(registry, {
      getGatewayRequestContext,
    });
    runtimeState.wss.once("connection", (socket) => socket.close());
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
    let gatewaySocket: WebSocket | undefined;
    try {
      await expect(fetch(`http://127.0.0.1:${address.port}/missing`)).resolves.toMatchObject({
        status: 404,
      });
      expect(mocks.pluginsHttpModuleLoaded).not.toHaveBeenCalled();
      expect(getGatewayRequestContext).not.toHaveBeenCalled();

      gatewaySocket = new WebSocket(`ws://127.0.0.1:${address.port}/`, {
        handshakeTimeout: 2_000,
      });
      await new Promise<void>((resolve, reject) => {
        gatewaySocket?.once("open", resolve);
        gatewaySocket?.once("error", reject);
      });
      expect(mocks.pluginsHttpModuleLoaded).not.toHaveBeenCalled();
      expect(getGatewayRequestContext).not.toHaveBeenCalled();
      expect(pluginUpgrade).not.toHaveBeenCalled();

      await expect(requestPluginUpgrade(address.port, "/plugin")).resolves.toContain(
        "101 Switching Protocols",
      );
      expect(mocks.pluginsHttpModuleLoaded).toHaveBeenCalledTimes(1);
      expect(pluginUpgrade).toHaveBeenCalledTimes(1);
    } finally {
      gatewaySocket?.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("returns a retryable response for plugin paths until startup sidecars are ready", async () => {
    const startupRegistry = createEmptyPluginRegistry();
    let runtimeRegistry = startupRegistry;
    let sidecarsReady = false;
    const pluginHandler = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
      return true;
    });
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry, {
      getPluginRouteRegistry: () => runtimeRegistry,
      isStartupPluginRuntimeReady: () => sidecarsReady,
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
      const startingResponse = await fetch(`http://127.0.0.1:${address.port}/slack/events`);
      expect(startingResponse.status).toBe(503);
      expect(startingResponse.headers.get("retry-after")).toBe("1");
      expect(startingResponse.headers.get("cache-control")).toBe("no-store");
      expect(await startingResponse.text()).toBe("Plugin runtime is starting");
      expect(pluginHandler).not.toHaveBeenCalled();

      await expect(fetch(`http://127.0.0.1:${address.port}/healthz`)).resolves.toMatchObject({
        status: 200,
      });

      const loadedRegistry = createEmptyPluginRegistry();
      loadedRegistry.httpRoutes.push({
        path: "/slack/events",
        auth: "plugin",
        match: "exact",
        handler: pluginHandler,
        pluginId: "slack",
        source: "test",
      });
      runtimeRegistry = loadedRegistry;
      sidecarsReady = true;

      await expect(fetch(`http://127.0.0.1:${address.port}/slack/events`)).resolves.toMatchObject({
        status: 204,
      });
      expect(pluginHandler).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a loaded plugin upgrade handler on the current route registry", async () => {
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
      await expect(requestPluginUpgrade(address.port, "/demo")).resolves.not.toContain(
        "101 Switching Protocols",
      );
      expect(startupUpgradeCalls).toBe(1);

      runtimeRegistry = replacementRegistry;

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

  it("claims managed Tailscale routing before ordinary ingress starts listening", async () => {
    const events: string[] = [];
    mocks.resolveGatewayListenHosts.mockResolvedValue(["127.0.0.1", "::1"]);
    mocks.listenGatewayHttpServer.mockImplementation(async (params) => {
      mockEphemeralAddress(params);
      events.push(
        params.serviceName === "Tailscale gateway ingress"
          ? "private-listener"
          : "ordinary-listener",
      );
    });
    const prepareManagedTailscaleIngress = vi.fn(async () => {
      events.push("tailscale-route");
    });
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
      tailscaleMode: "serve",
      prepareManagedTailscaleIngress,
    });

    await runtimeState.startListening();

    expect(events).toEqual([
      "private-listener",
      "tailscale-route",
      "ordinary-listener",
      "ordinary-listener",
    ]);
    expect(prepareManagedTailscaleIngress).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 19_000,
    });
    expect(mocks.listenGatewayHttpServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        bindHost: "127.0.0.1",
        port: 0,
        retryEaddrinuse: false,
      }),
    );
    expect(runtimeState.httpBindHosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("leaves ordinary ingress closed when managed Tailscale routing fails", async () => {
    const routeFailure = new Error("route claim failed");
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
      tailscaleMode: "serve",
      prepareManagedTailscaleIngress: async () => {
        throw routeFailure;
      },
    });

    await expect(runtimeState.startListening()).rejects.toBe(routeFailure);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        bindHost: "127.0.0.1",
        port: 0,
        serviceName: "Tailscale gateway ingress",
      }),
    );
    expect(runtimeState.httpBindHosts).toEqual([]);
  });

  it("does not publish managed ingress when Tailscale mode is off", async () => {
    const prepareManagedTailscaleIngress = vi.fn();
    const runtimeState = await createGatewayRuntimeStateForTest(undefined, {
      port: 18789,
      tailscaleMode: "off",
      prepareManagedTailscaleIngress,
    });

    await runtimeState.startListening();

    expect(runtimeState.getTailscaleIngressEndpoint()).toBeUndefined();
    expect(prepareManagedTailscaleIngress).not.toHaveBeenCalled();
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledTimes(1);
    expect(mocks.listenGatewayHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({ bindHost: "127.0.0.1", port: 18789 }),
    );
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
