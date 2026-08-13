import { request as httpRequest, type RequestOptions } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

async function requestStatus(options: RequestOptions): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

async function requestUpgrade(options: RequestOptions): Promise<{
  status: number;
  body: string;
}> {
  const requestHeaders = options.headers;
  if (Array.isArray(requestHeaders)) {
    throw new Error("upgrade test headers must use object form");
  }
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      ...options,
      headers: Object.assign({}, requestHeaders, {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      }),
    });
    req.setTimeout(2_000, () => req.destroy(new Error("upgrade rejection timed out")));
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.once("upgrade", (res, socket, head) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: head.toString("utf8") });
    });
    req.once("error", reject);
    req.end();
  });
}

describe("managed Tailscale gateway ingress", () => {
  const openServers: Array<Awaited<ReturnType<typeof createGatewayRuntimeStateForTest>>> = [];

  afterEach(async () => {
    for (const runtime of openServers.splice(0)) {
      await Promise.all(
        runtime.httpServers.map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close(() => resolve());
            }),
        ),
      );
      runtime.wss.close();
    }
  });

  it("keeps ordinary ingress closed until the managed route is claimed", async () => {
    let releaseRouteClaim: () => void = () => {};
    const routeClaim = new Promise<void>((resolve) => {
      releaseRouteClaim = resolve;
    });
    const prepareManagedTailscaleIngress = vi.fn(async () => await routeClaim);
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      tailscaleMode: "serve",
      prepareManagedTailscaleIngress,
    });
    openServers.push(runtime);

    const starting = runtime.startListening();
    await vi.waitFor(() => expect(prepareManagedTailscaleIngress).toHaveBeenCalledOnce());

    expect(runtime.getTailscaleIngressEndpoint()).toMatchObject({ host: "127.0.0.1" });
    expect(runtime.httpServer.listening).toBe(false);

    releaseRouteClaim();
    await starting;
    expect(runtime.httpServer.listening).toBe(true);
  });

  it("binds a distinct private listener and rejects the same headers on the ordinary listener", async () => {
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      tailscaleMode: "serve",
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
    });
    openServers.push(runtime);
    await runtime.startListening();
    const ordinaryAddress = runtime.httpServer.address();
    const tailscaleAddress = runtime.getTailscaleIngressEndpoint();
    if (!ordinaryAddress || typeof ordinaryAddress === "string" || !tailscaleAddress) {
      throw new Error("expected both gateway listeners");
    }
    expect(tailscaleAddress.port).not.toBe(ordinaryAddress.port);

    const headers = {
      "x-forwarded-for": "100.64.0.10",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.tailnet.ts.net",
    };
    const ordinaryResponses = await Promise.all(
      ["/ready", "/v1/models", "/api/users/profile-1/avatar"].map((path) =>
        requestStatus({
          host: "127.0.0.1",
          port: ordinaryAddress.port,
          path,
          headers,
        }),
      ),
    );
    const managed = await requestStatus({
      host: tailscaleAddress.host,
      port: tailscaleAddress.port,
      path: "/ready",
      headers,
    });

    for (const ordinary of ordinaryResponses) {
      expect(ordinary).toMatchObject({ status: 403 });
      expect(ordinary.body).toContain("proxy_attribution_required");
    }
    expect(managed.status).toBe(200);
  });

  it("requires the Funnel marker on the dedicated Funnel listener", async () => {
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      tailscaleMode: "funnel",
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
    });
    openServers.push(runtime);
    await runtime.startListening();
    const endpoint = runtime.getTailscaleIngressEndpoint();
    if (!endpoint) {
      throw new Error("expected Funnel listener");
    }
    const baseHeaders = {
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.example",
    };

    const missingMarker = await requestStatus({
      host: endpoint.host,
      port: endpoint.port,
      path: "/ready",
      headers: baseHeaders,
    });
    const marked = await requestStatus({
      host: endpoint.host,
      port: endpoint.port,
      path: "/ready",
      headers: { ...baseHeaders, "tailscale-funnel-request": "?1" },
    });

    expect(missingMarker.status).toBe(403);
    expect(marked.status).toBe(200);
  });

  it("isolates protected Funnel auth lockout by the validated source", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });
    const auth = { mode: "token" as const, token: "secret", allowTailscale: false };
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      tailscaleMode: "funnel",
      openAiChatCompletionsEnabled: true,
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
      rateLimiter: limiter,
    });
    openServers.push(runtime);
    try {
      await runtime.startListening();
      const ordinaryAddress = runtime.httpServer.address();
      const endpoint = runtime.getTailscaleIngressEndpoint();
      if (!ordinaryAddress || typeof ordinaryAddress === "string" || !endpoint) {
        throw new Error("expected both gateway listeners");
      }
      const requestFrom = (clientIp: string, token: string) =>
        requestStatus({
          host: endpoint.host,
          port: endpoint.port,
          path: "/v1/models",
          headers: {
            authorization: `Bearer ${token}`,
            "x-forwarded-for": clientIp,
            "x-forwarded-proto": "https",
            "x-forwarded-host": "gateway.example",
            "tailscale-funnel-request": "?1",
          },
        });

      await expect(requestFrom("203.0.113.10", "wrong")).resolves.toMatchObject({ status: 401 });
      await expect(requestFrom("203.0.113.10", "secret")).resolves.toMatchObject({ status: 429 });
      await expect(requestFrom("203.0.113.11", "secret")).resolves.toMatchObject({ status: 200 });
      await expect(
        requestStatus({
          host: "127.0.0.1",
          port: ordinaryAddress.port,
          path: "/v1/models",
          headers: { authorization: "Bearer secret" },
        }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      limiter.dispose();
    }
  });

  it("routes proxy-shaped WebSocket upgrades only to plugin-authenticated routes", async () => {
    const registry = createEmptyPluginRegistry();
    const observedClient = vi.fn();
    registry.httpRoutes.push({
      path: "/plugin-ws",
      auth: "plugin",
      match: "exact",
      handler: () => false,
      handleUpgrade: (req, socket) => {
        observedClient({
          remoteAddress: req.socket.remoteAddress,
          clientIp: getPluginRuntimeGatewayRequestScope()?.client?.clientIp,
        });
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        return true;
      },
      pluginId: "plugin-ws",
      source: "test",
    });
    const runtime = await createGatewayRuntimeStateForTest(registry, {
      tailscaleMode: "serve",
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
    });
    openServers.push(runtime);
    await runtime.startListening();
    const ordinaryAddress = runtime.httpServer.address();
    if (!ordinaryAddress || typeof ordinaryAddress === "string") {
      throw new Error("expected ordinary gateway listener");
    }
    const proxyHeaders = {
      "x-forwarded-for": "198.51.100.20",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.example",
    };

    await expect(
      requestUpgrade({
        host: "127.0.0.1",
        port: ordinaryAddress.port,
        path: "/plugin-ws",
        headers: proxyHeaders,
      }),
    ).resolves.toMatchObject({ status: 101 });
    expect(observedClient).toHaveBeenCalledWith({
      remoteAddress: "127.0.0.1",
      clientIp: "127.0.0.1",
    });
    expect(observedClient).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "198.51.100.20" }),
    );

    const rejectedGatewayUpgrade = await requestUpgrade({
      host: "127.0.0.1",
      port: ordinaryAddress.port,
      path: "/ready",
      headers: proxyHeaders,
    });
    expect(rejectedGatewayUpgrade.status).toBe(403);
    expect(rejectedGatewayUpgrade.body).toContain("proxy_attribution_required");
  });

  it("reports HTTP and WebSocket proxy ingress once without warning for attributable traffic", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const runtime = await createGatewayRuntimeStateForTest(undefined, {
      tailscaleMode: "serve",
      getReadiness: () => ({ ready: true, failing: [], uptimeMs: 1 }),
      log,
    });
    openServers.push(runtime);
    await runtime.startListening();
    const ordinaryAddress = runtime.httpServer.address();
    const endpoint = runtime.getTailscaleIngressEndpoint();
    if (!ordinaryAddress || typeof ordinaryAddress === "string" || !endpoint) {
      throw new Error("expected both gateway listeners");
    }

    await expect(
      requestStatus({
        host: "127.0.0.1",
        port: ordinaryAddress.port,
        path: "/ready",
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      requestStatus({
        host: endpoint.host,
        port: endpoint.port,
        path: "/ready",
        headers: {
          "x-forwarded-for": "100.64.0.10",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "gateway.tailnet.ts.net",
        },
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(log.warn).not.toHaveBeenCalled();

    const proxyRequest = {
      host: "127.0.0.1",
      port: ordinaryAddress.port,
      path: "/ready",
      headers: {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gateway.example",
      },
    } satisfies RequestOptions;
    const rejectedHttp = await requestStatus(proxyRequest);
    const rejectedWebSocket = await requestUpgrade(proxyRequest);

    expect(rejectedHttp.status).toBe(403);
    expect(rejectedHttp.body).toContain("proxy_attribution_required");
    expect(rejectedWebSocket.status).toBe(403);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("gateway.trustedProxies"));
  });
});
