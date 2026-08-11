import { request as httpRequest, type RequestOptions } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function requestRejectedUpgrade(options: RequestOptions): Promise<{
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
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected upgrade to reject"));
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
    const rejectedWebSocket = await requestRejectedUpgrade(proxyRequest);

    expect(rejectedHttp.status).toBe(403);
    expect(rejectedHttp.body).toContain("proxy_attribution_required");
    expect(rejectedWebSocket.status).toBe(403);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("gateway.trustedProxies"));
  });
});
