import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OpenClawPluginHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

const issueDeviceBootstrapToken = vi.hoisted(() =>
  vi.fn(async () => ({ token: "issued", expiresAtMs: Date.now() + 600_000 })),
);
const resolveTelegramMiniAppUrls = vi.hoisted(() =>
  vi.fn(async () => ({
    pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
    controlUiUrl: "https://host.tailnet.ts.net/openclaw",
    gatewayUrl: "wss://host.tailnet.ts.net",
  })),
);

vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  issueDeviceBootstrapToken,
}));

vi.mock("./url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./url.js")>()),
  resolveTelegramMiniAppUrls,
}));

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    return this;
  }

  end(body?: string) {
    this.body = body ?? "";
    return this;
  }
}

// The rate-limit map is module-level state; reset modules so each test starts empty.
async function createRoute(): Promise<OpenClawPluginHttpRouteParams> {
  const { registerTelegramMiniAppRoutes } = await import("./routes.js");
  let route: OpenClawPluginHttpRouteParams | null = null;
  const api = createTestPluginApi({
    config: {} as OpenClawConfig,
    registerHttpRoute(params) {
      route = params;
    },
  });
  registerTelegramMiniAppRoutes(api);
  if (!route) {
    throw new Error("expected miniapp route registration");
  }
  return route;
}

// Posts an auth request with an invalid body: it consumes rate limit, then fails validation.
async function postAuth(route: OpenClawPluginHttpRouteParams, ip: string) {
  const req = Readable.from(["{}"]) as IncomingMessage;
  req.method = "POST";
  req.url = "/__openclaw_tg_miniapp/auth";
  req.headers = { "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: ip } });
  const res = new MockResponse() as ServerResponse & MockResponse;
  await route.handler(req, res);
  return res;
}

function testIp(index: number): string {
  return `198.51.${(index >> 8) & 255}.${index & 255}`;
}

beforeEach(() => {
  vi.resetModules();
  issueDeviceBootstrapToken.mockClear();
  resolveTelegramMiniAppUrls.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("miniapp auth rate-limit map bounds", () => {
  it("evicts the oldest IP entry once the map exceeds its cap", async () => {
    const route = await createRoute();
    const flooder = "203.0.113.40";
    for (let i = 0; i < 10; i += 1) {
      expect((await postAuth(route, flooder)).statusCode).toBe(401);
    }
    expect((await postAuth(route, flooder)).statusCode).toBe(429);

    // Push the flooder's entry out of the map with more distinct IPs than the cap.
    for (let i = 0; i < 1025; i += 1) {
      await postAuth(route, testIp(i));
    }

    // Evicted entry restarts with a fresh window instead of staying at the limit.
    expect((await postAuth(route, flooder)).statusCode).toBe(401);
  });

  it("sweeps expired windows before capping so active entries survive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const route = await createRoute();
    const sticky = "203.0.113.41";
    expect((await postAuth(route, sticky)).statusCode).toBe(401);

    vi.setSystemTime(1_000_000 + 30_000);
    for (let i = 0; i < 1023; i += 1) {
      await postAuth(route, testIp(i));
    }

    // Sticky's first window expired; a revisit must restart it without dropping live neighbors.
    vi.setSystemTime(1_000_000 + 61_000);
    expect((await postAuth(route, sticky)).statusCode).toBe(401);
    expect((await postAuth(route, "203.0.113.42")).statusCode).toBe(401);

    // Sticky kept its entry: nine more requests reach the per-IP limit and the next is rejected.
    for (let i = 0; i < 9; i += 1) {
      expect((await postAuth(route, sticky)).statusCode).toBe(401);
    }
    expect((await postAuth(route, sticky)).statusCode).toBe(429);
  });

  it("keeps an actively consuming IP beyond the cap instead of resetting its window", async () => {
    const route = await createRoute();
    const active = "203.0.113.43";

    // The attacker consumes five of its ten allowed requests.
    for (let i = 0; i < 5; i += 1) {
      expect((await postAuth(route, active)).statusCode).toBe(401);
    }

    // More distinct IPs than the cap flood the map; the attacker keeps consuming through the
    // flood, which must refresh its recency instead of leaving it at the eviction front.
    for (let i = 0; i < 1025; i += 1) {
      await postAuth(route, testIp(i));
      if (i === 512 || i === 1024) {
        expect((await postAuth(route, active)).statusCode).toBe(401);
      }
    }

    // Recency refresh kept the attacker's entry: the remaining budget applies and the eleventh
    // request is rejected instead of the entry being evicted into a fresh window.
    for (let i = 0; i < 3; i += 1) {
      expect((await postAuth(route, active)).statusCode).toBe(401);
    }
    expect((await postAuth(route, active)).statusCode).toBe(429);
  });
});
