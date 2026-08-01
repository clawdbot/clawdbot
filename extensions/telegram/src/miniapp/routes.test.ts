import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { registerTelegramMiniAppRoutes } = await import("./routes.js");

const BOT_TOKEN = "fixture";
let signedNonceSequence = 0;

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

function createRoute(cfg: OpenClawConfig): OpenClawPluginHttpRouteParams {
  let route: OpenClawPluginHttpRouteParams | null = null;
  const api = createTestPluginApi({
    config: cfg,
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

async function callRoute(params: {
  route: OpenClawPluginHttpRouteParams;
  method: string;
  url: string;
  body?: string;
  contentType?: string;
  ip?: string;
}) {
  const req = Readable.from(params.body ? [params.body] : []) as IncomingMessage;
  req.method = params.method;
  req.url = params.url;
  req.headers = params.contentType ? { "content-type": params.contentType } : {};
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: params.ip ?? "203.0.113.10" },
  });
  const res = new MockResponse() as ServerResponse & MockResponse;
  await params.route.handler(req, res);
  return res;
}

function config(allowFrom: string[] = ["123456"]): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: BOT_TOKEN,
        allowFrom,
      },
    },
    gateway: { tailscale: { mode: "funnel" } },
  };
}

function signedInitData(userId: string, nonce: string): string {
  signedNonceSequence += 1;
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `${nonce}-${signedNonceSequence}`,
    user: JSON.stringify({ id: Number(userId), first_name: "Ayaan" }),
  });
  const entries = [...params.entries()].map(([key, value]) => `${key}=${value}`).toSorted();
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(entries.join("\n")).digest("hex"));
  return params.toString();
}

describe("registerTelegramMiniAppRoutes", () => {
  beforeEach(() => {
    issueDeviceBootstrapToken.mockClear();
    resolveTelegramMiniAppUrls.mockClear();
  });

  it("serves the page without resolving published URLs", async () => {
    const route = createRoute({});
    const res = await callRoute({
      route,
      method: "GET",
      url: "/__openclaw_tg_miniapp/?accountId=ops",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('const accountId = "ops";');
    expect(res.body).toContain("new URL(payload.controlUiUrl)");
    expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
  });

  it("mints a control-ui bootstrap token for a valid owner request", async () => {
    const route = createRoute(config());
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        initData: signedInitData("123456", "success"),
        accountId: "default",
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      bootstrapToken: "issued",
      controlUiUrl: "https://host.tailnet.ts.net/openclaw",
      gatewayUrl: "wss://host.tailnet.ts.net",
    });
    expect(issueDeviceBootstrapToken).toHaveBeenCalledWith({
      profile: {
        roles: ["operator"],
        scopes: [
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        purpose: "control-ui",
      },
    });
  });

  it("rejects replayed init-data without minting again", async () => {
    const route = createRoute(config());
    const initData = signedInitData("123456", "replay");
    await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData }),
      ip: "203.0.113.20",
    });
    const replay = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData }),
      ip: "203.0.113.20",
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.body).toBe("This link expired. Reopen the dashboard from your bot chat.");
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("reserves validated init-data before minting", async () => {
    const route = createRoute(config());
    const initData = signedInitData("123456", "concurrent");

    const responses = await Promise.all([
      callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData }),
        ip: "203.0.113.21",
      }),
      callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData }),
        ip: "203.0.113.22",
      }),
    ]);

    expect(responses.map((res) => res.statusCode).toSorted((a, b) => a - b)).toEqual([200, 401]);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("rejects non-owner Mini App auth requests", async () => {
    const route = createRoute(config(["999999"]));
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData: signedInitData("123456", "non-owner") }),
      ip: "203.0.113.30",
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Restricted to the bot owner.");
  });

  it("rate-limits repeated auth requests by IP", async () => {
    const route = createRoute(config());
    let last: MockResponse | null = null;
    for (let i = 0; i < 11; i += 1) {
      last = await callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData: signedInitData("123456", `rate-${i}`) }),
        ip: "203.0.113.40",
      });
    }

    expect(last?.statusCode).toBe(429);
    expect(last?.body).toBe("Too many requests");
  });
});
