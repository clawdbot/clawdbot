import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { Readable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramMiniAppLaunchTickets,
  type TelegramMiniAppLaunchTickets,
} from "./launch-ticket.js";

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

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

const { registerTelegramMiniAppRoutes } = await import("./routes.js");

const BOT_TOKEN = "fixture";
const AUTH_BODY_MAX_BYTES = 4096;
let signedNonceSequence = 0;
let launchTickets: TelegramMiniAppLaunchTickets;

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  end(body?: string) {
    this.body = body ?? "";
    this.emit("finish");
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
  registerTelegramMiniAppRoutes(api, launchTickets);
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
  return await callRouteRequest(params.route, req);
}

async function callRouteRequest(route: OpenClawPluginHttpRouteParams, req: IncomingMessage) {
  const res = new MockResponse() as ServerResponse & MockResponse;
  await route.handler(req, res);
  return res;
}

function createPendingAuthRequest(ip: string): IncomingMessage {
  const req = new Readable({
    read() {
      // Keep the body open so the canonical reader owns timeout settlement.
    },
  }) as IncomingMessage;
  req.method = "POST";
  req.url = "/__openclaw_tg_miniapp/auth";
  req.headers = { "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: ip } });
  return req;
}

function expectBodyReadListenersCleaned(req: IncomingMessage) {
  for (const event of ["data", "end", "error", "close"] as const) {
    expect(req.listenerCount(event), event).toBe(0);
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return address.port;
}

async function readSocketResponse(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });
}

function createRouteServer(route: OpenClawPluginHttpRouteParams): Server {
  return createServer((req, res) => {
    void route.handler(req, res);
  });
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

function authBody(params: { userId?: string; nonce: string; accountId?: string }): string {
  const userId = params.userId ?? "123456";
  const accountId = params.accountId ?? "default";
  return JSON.stringify({
    initData: signedInitData(userId, params.nonce),
    accountId,
    launchTicket: launchTickets.issue({ accountId, userId }),
  });
}

describe("registerTelegramMiniAppRoutes", () => {
  beforeEach(() => {
    launchTickets = createTelegramMiniAppLaunchTickets();
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
      body: authBody({ nonce: "success" }),
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
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });
    await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData, launchTicket }),
      ip: "203.0.113.20",
    });
    const replay = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData, launchTicket }),
      ip: "203.0.113.20",
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.body).toBe("This link expired. Reopen the dashboard from your bot chat.");
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("reserves validated init-data before minting", async () => {
    const route = createRoute(config());
    const initData = signedInitData("123456", "concurrent");
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });

    const responses = await Promise.all([
      callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData, launchTicket }),
        ip: "203.0.113.21",
      }),
      callRoute({
        route,
        method: "POST",
        url: "/__openclaw_tg_miniapp/auth",
        contentType: "application/json",
        body: JSON.stringify({ initData, launchTicket }),
        ip: "203.0.113.22",
      }),
    ]);

    expect(responses.map((res) => res.statusCode).toSorted((a, b) => a - b)).toEqual([200, 401]);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
  });

  it("rejects non-owner Mini App auth requests", async () => {
    const route = createRoute(config(["999999"]));
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({
        initData: signedInitData("123456", "non-owner"),
        launchTicket,
      }),
      ip: "203.0.113.30",
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Restricted to the bot owner.");
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(
      launchTickets.consume({ ticket: launchTicket, accountId: "default", userId: "123456" }),
    ).toBe(true);
  });

  it("rejects owner init-data without an issued launch ticket", async () => {
    const route = createRoute(config());
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({
        initData: signedInitData("123456", "missing-ticket"),
        launchTicket: "not-issued",
      }),
      ip: "203.0.113.31",
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("This link expired. Reopen the dashboard from your bot chat.");
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("does not consume a launch ticket when URL resolution fails", async () => {
    resolveTelegramMiniAppUrls.mockRejectedValueOnce(new Error("not published"));
    const route = createRoute(config());
    const initData = signedInitData("123456", "url-retry");
    const launchTicket = launchTickets.issue({ accountId: "default", userId: "123456" });
    const request = {
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: JSON.stringify({ initData, launchTicket }),
      ip: "203.0.113.32",
    };

    const unavailable = await callRoute(request);
    const retry = await callRoute(request);

    expect(unavailable.statusCode).toBe(503);
    expect(retry.statusCode).toBe(200);
    expect(issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
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
        body: authBody({ nonce: `rate-${i}` }),
        ip: "203.0.113.40",
      });
    }

    expect(last?.statusCode).toBe(429);
    expect(last?.body).toBe("Too many requests");
  });

  it("keeps malformed JSON on the expired-link response", async () => {
    const route = createRoute(config());
    const res = await callRoute({
      route,
      method: "POST",
      url: "/__openclaw_tg_miniapp/auth",
      contentType: "application/json",
      body: "{",
      ip: "203.0.113.49",
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("This link expired. Reopen the dashboard from your bot chat.");
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("rejects an oversized auth body and closes the request", async () => {
    const route = createRoute(config());
    const req = Readable.from(["x".repeat(4097)]) as IncomingMessage;
    req.method = "POST";
    req.url = "/__openclaw_tg_miniapp/auth";
    req.headers = { "content-type": "application/json" };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.50" } });

    const res = await callRouteRequest(route, req);

    expect(res.statusCode).toBe(413);
    expect(res.body).toBe("Payload too large");
    expect(req.destroyed).toBe(true);
    expectBodyReadListenersCleaned(req);
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("flushes a real HTTP 413 response before closing an oversized auth request", async () => {
    const server = createRouteServer(createRoute(config()));
    let socket: Socket | undefined;
    try {
      const port = await listen(server);
      socket = connect({ host: "127.0.0.1", port });
      await new Promise<void>((resolve) => {
        socket?.once("connect", resolve);
      });

      socket.write(
        [
          "POST /__openclaw_tg_miniapp/auth HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          `Content-Length: ${AUTH_BODY_MAX_BYTES + 1}`,
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"),
      );

      const response = await readSocketResponse(socket);
      const [, body = ""] = response.split("\r\n\r\n", 2);

      expect(response).toContain("HTTP/1.1 413");
      expect(response).toContain("Connection: close");
      expect(body).toBe("Payload too large");
      expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
    } finally {
      socket?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("settles an early client close without leaking request-body listeners", async () => {
    const route = createRoute(config());
    const req = createPendingAuthRequest("203.0.113.51");
    const responsePromise = callRouteRequest(route, req);

    req.emit("close");
    const res = await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Connection closed");
    expectBodyReadListenersCleaned(req);
    expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("times out a slow auth body and closes the request", async () => {
    const route = createRoute(config());
    const req = createPendingAuthRequest("203.0.113.52");
    try {
      const res = await callRouteRequest(route, req);

      expect(res.statusCode).toBe(408);
      expect(res.body).toBe("Request body timeout");
      expect(req.destroyed).toBe(true);
      expectBodyReadListenersCleaned(req);
      expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
    } finally {
      req.destroy();
    }
  }, 10_000);

  it("flushes a real HTTP 408 response before closing a stalled auth request", async () => {
    vi.useFakeTimers();
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const route = createRoute(config());
    const server = createServer((req, res) => {
      void route.handler(req, res);
      markRequestStarted?.();
    });
    let socket: Socket | undefined;
    try {
      const port = await listen(server);
      socket = connect({ host: "127.0.0.1", port });
      await new Promise<void>((resolve) => {
        socket?.once("connect", resolve);
      });

      socket.write(
        [
          "POST /__openclaw_tg_miniapp/auth HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 64",
          "Connection: keep-alive",
          "",
          "{",
        ].join("\r\n"),
      );

      await requestStarted;
      const responsePromise = readSocketResponse(socket);
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      const [, body = ""] = response.split("\r\n\r\n", 2);

      expect(response).toContain("HTTP/1.1 408");
      expect(response).toContain("Connection: close");
      expect(body).toBe("Request body timeout");
      expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      socket?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
