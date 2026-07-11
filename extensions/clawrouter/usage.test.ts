import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { fetchClawRouterUsage, type ClawRouterUsageFetchGuard } from "./usage.js";

const runningServers: Server[] = [];
const runningSockets = new Set<Duplex>();
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const savedProxyEnv = new Map<string, string | undefined>();

function trackSocket(socket: Duplex): void {
  runningSockets.add(socket);
  socket.once("close", () => runningSockets.delete(socket));
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  runningServers.push(server);
  return (server.address() as AddressInfo).port;
}

async function startUsageServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    handler(req, res);
  });
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
  };
}

async function startConnectProxy(): Promise<{ proxyUrl: string; connects: string[] }> {
  const connects: string[] = [];
  const server = createServer();
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url;
    if (!target) {
      clientSocket.destroy();
      return;
    }
    connects.push(target);
    trackSocket(clientSocket);
    const targetUrl = new URL(`http://${target}`);
    const targetSocket = connect(Number(targetUrl.port), targetUrl.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        targetSocket.write(head);
      }
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    trackSocket(targetSocket);
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
  });
  const port = await listenOnLoopback(server);
  return { proxyUrl: `http://127.0.0.1:${port}`, connects };
}

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    savedProxyEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const socket of runningSockets) {
    socket.destroy();
  }
  runningSockets.clear();
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const key of PROXY_ENV_KEYS) {
    const value = savedProxyEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedProxyEnv.clear();
});

function mockFetchGuard(response: Response): MockedFunction<ClawRouterUsageFetchGuard> {
  return vi.fn(async ({ url }) => ({
    response,
    finalUrl: url,
    release: async () => undefined,
  }));
}

describe("ClawRouter usage", () => {
  it("maps the managed monthly budget and usage totals", async () => {
    const fetchGuard = mockFetchGuard(
      Response.json({
        budget: {
          configured: true,
          ledger: "durable_object",
          windowKey: "default/test-policy/2026-07",
          limitMicros: 100_000_000,
          spentMicros: 25_000_000,
          remainingMicros: 75_000_000,
        },
        usage: {
          summary: {
            requestCount: 12,
            totalTokens: 34_567,
            actualCostMicros: 25_000_000,
          },
        },
      }),
    );

    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      baseUrl: "https://clawrouter.example/v1",
      timeoutMs: 5000,
      fetchGuard,
    });

    expect(snapshot).toEqual({
      provider: "clawrouter",
      displayName: "ClawRouter",
      windows: [
        {
          label: "Monthly budget",
          usedPercent: 25,
          resetAt: Date.UTC(2026, 7, 1),
        },
      ],
      billing: [
        {
          type: "budget",
          used: 25,
          limit: 100,
          unit: "USD",
          period: "month",
          resetAt: Date.UTC(2026, 7, 1),
        },
      ],
      summary: "12 requests · 34,567 tokens · $25.00 used",
      plan: "Managed monthly budget",
    });
    expect(fetchGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://clawrouter.example/v1/usage",
        init: expect.objectContaining({
          headers: {
            Accept: "application/json",
            Authorization: "Bearer proxy-key",
          },
        }),
        auditContext: "clawrouter.usage",
        mode: "trusted_env_proxy",
      }),
    );
    expect(fetchGuard.mock.calls[0]?.[0]).not.toHaveProperty("fetchImpl");
  });

  it("shows aggregate usage for an unmetered key", async () => {
    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      timeoutMs: 5000,
      fetchGuard: mockFetchGuard(
        Response.json({
          budget: { configured: false, ledger: "unmetered" },
          usage: { summary: { requestCount: 0, totalTokens: 0, actualCostMicros: 0 } },
        }),
      ),
    });

    expect(snapshot.windows).toEqual([]);
    expect(snapshot.summary).toBe("0 requests · 0 tokens · $0.00 used");
    expect(snapshot.plan).toBe("Unmetered proxy key");
    expect(snapshot.billing).toEqual([{ type: "spend", amount: 0, unit: "USD" }]);
  });

  it("does not expose an upstream error body", async () => {
    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        timeoutMs: 5000,
        fetchGuard: mockFetchGuard(new Response("secret details", { status: 403 })),
      }),
    ).rejects.toThrow("ClawRouter usage request failed (HTTP 403)");
  });

  it("bounds successful usage response bodies", async () => {
    const oversizedPayload = JSON.stringify({
      budget: { configured: false },
      usage: { summary: { requestCount: 1 } },
      padding: "x".repeat(1024 * 1024),
    });

    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        timeoutMs: 5000,
        fetchGuard: mockFetchGuard(
          new Response(oversizedPayload, {
            headers: { "content-type": "application/json" },
          }),
        ),
      }),
    ).rejects.toThrow("ClawRouter usage response exceeds");
  });

  it("fetches usage through the production SSRF-guarded transport", async () => {
    const { baseUrl, requests } = await startUsageServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer proxy-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          budget: { configured: false, ledger: "unmetered" },
          usage: { summary: { requestCount: 3, totalTokens: 9, actualCostMicros: 0 } },
        }),
      );
    });

    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      baseUrl,
      timeoutMs: 5000,
    });

    expect(snapshot.summary).toBe("3 requests · 9 tokens · $0.00 used");
    expect(snapshot.plan).toBe("Unmetered proxy key");
    expect(requests).toEqual(["GET /v1/usage"]);
  });

  it("preserves provider usage routing through the env proxy", async () => {
    const { baseUrl } = await startUsageServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(
        JSON.stringify({
          budget: { configured: false, ledger: "unmetered" },
          usage: { summary: { requestCount: 2, totalTokens: 8, actualCostMicros: 0 } },
        }),
      );
    });
    const { proxyUrl, connects } = await startConnectProxy();
    process.env.HTTP_PROXY = proxyUrl;

    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      baseUrl,
      timeoutMs: 5000,
    });

    expect(snapshot.summary).toBe("2 requests · 8 tokens · $0.00 used");
    expect(connects).toEqual([new URL(baseUrl).host]);
  });

  it("blocks private-network redirects before a second proxied request", async () => {
    const { baseUrl, requests } = await startUsageServer((_req, res) => {
      res.writeHead(302, { Location: "http://10.0.0.1:9/v1/usage" });
      res.end();
    });
    const { proxyUrl, connects } = await startConnectProxy();
    process.env.HTTP_PROXY = proxyUrl;

    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        baseUrl,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(requests).toEqual(["GET /v1/usage"]);
    expect(connects).toEqual([new URL(baseUrl).host]);
  });
});
