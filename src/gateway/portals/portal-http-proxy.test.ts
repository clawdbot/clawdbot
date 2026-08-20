import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

type HttpResult = {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
};

let targetPort = 0;
let targetHandler: (req: IncomingMessage, res: ServerResponse) => void;
let targetWebSocketPath: string | undefined;
let targetWebSocketCookie: string | undefined;
let targetWebSocketSetCookie: string | undefined;
const targetServer = createServer((req, res) => targetHandler(req, res));
const targetWss = new WebSocketServer({ server: targetServer });
const services = new Set<GatewayPortalService>();
const temporaryTargetServers = new Set<Server>();

beforeAll(async () => {
  targetWss.on("connection", (socket, req) => {
    targetWebSocketPath = req.url;
    targetWebSocketCookie = req.headers.cookie;
    socket.on("message", (data) => socket.send(data));
  });
  targetWss.on("headers", (headers) => {
    if (targetWebSocketSetCookie) {
      headers.push(`Set-Cookie: ${targetWebSocketSetCookie}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject);
    targetServer.listen(0, "127.0.0.1", () => resolve());
  });
  targetPort = (targetServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await Promise.all([...services].map((service) => service.closeAll()));
  services.clear();
  await Promise.all(
    [...temporaryTargetServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  temporaryTargetServers.clear();
  targetWebSocketPath = undefined;
  targetWebSocketCookie = undefined;
  targetWebSocketSetCookie = undefined;
});

afterAll(async () => {
  targetWss.close();
  await new Promise<void>((resolve) => {
    targetServer.close(() => resolve());
  });
});

function portalService() {
  const service = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers: [] });
  services.add(service);
  return service;
}

async function listenTarget(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  temporaryTargetServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function httpCall(params: {
  port: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: params.path ?? "/",
        method: params.method,
        headers: params.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    if (params.body) {
      req.write(params.body);
    }
    req.end();
  });
}

function storeResponseCookies(jar: Map<string, string>, result: HttpResult): void {
  for (const cookie of result.headers["set-cookie"] ?? []) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function cookieJarHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function portalAuthCookie(portal: { listenPort: number; tokenQuery: string }): string {
  const token = portal.tokenQuery.slice("openclaw_portal=".length);
  return `openclaw_portal_${portal.listenPort}=${token}`;
}

function webSocketMessageText(data: RawData): string {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  return bytes.toString("utf8");
}

async function browserCall(
  jar: Map<string, string>,
  params: Omit<Parameters<typeof httpCall>[0], "headers">,
): Promise<HttpResult> {
  const cookie = cookieJarHeader(jar);
  const result = await httpCall({
    ...params,
    ...(cookie ? { headers: { Cookie: cookie } } : {}),
  });
  storeResponseCookies(jar, result);
  return result;
}

describe("portal HTTP proxy", () => {
  it("proxies a URL token directly, sets a private cookie, and strips the token", async () => {
    const targetPaths: string[] = [];
    targetHandler = (req, res) => {
      targetPaths.push(req.url ?? "/");
      res.statusCode = 200;
      res.end("proxied");
    };
    const portal = await portalService().open({ targetPort, title: "App" });

    const unauthorized = await httpCall({ port: portal.listenPort });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toContain("This portal is private");
    expect(unauthorized.body).not.toContain(portal.tokenQuery);

    const authorized = await httpCall({
      port: portal.listenPort,
      path: `/preview?x=1&${portal.tokenQuery}`,
    });
    expect(authorized.status).toBe(200);
    expect(authorized.body).toBe("proxied");
    expect(authorized.headers["set-cookie"]?.[0]).toContain(
      `openclaw_portal_${portal.listenPort}=`,
    );
    expect(authorized.headers["set-cookie"]?.[0]).toContain("HttpOnly; SameSite=Lax; Path=/");
    expect(targetPaths).toEqual(["/preview?x=1"]);

    const cookieOnly = await httpCall({
      port: portal.listenPort,
      path: "/cookie?y=2",
      headers: { Cookie: portalAuthCookie(portal) },
    });
    expect(cookieOnly).toMatchObject({ status: 200, body: "proxied" });
    expect(targetPaths).toEqual(["/preview?x=1", "/cookie?y=2"]);
  });

  it("keeps concurrent portal HTTP sessions authorized in A-B-A order", async () => {
    targetHandler = (_req, res) => {
      res.statusCode = 200;
      res.end("target-a");
    };
    const targetPortB = await listenTarget((_req, res) => {
      res.statusCode = 200;
      res.end("target-b");
    });
    const service = portalService();
    const portalA = await service.open({ targetPort });
    const portalB = await service.open({ targetPort: targetPortB });
    const jar = new Map<string, string>();

    expect(
      await browserCall(jar, {
        port: portalA.listenPort,
        path: `/?${portalA.tokenQuery}`,
      }),
    ).toMatchObject({ status: 200, body: "target-a" });
    expect(
      await browserCall(jar, {
        port: portalB.listenPort,
        path: `/?${portalB.tokenQuery}`,
      }),
    ).toMatchObject({ status: 200, body: "target-b" });

    for (const [portal, body] of [
      [portalA, "target-a"],
      [portalB, "target-b"],
      [portalA, "target-a"],
    ] as const) {
      expect(await browserCall(jar, { port: portal.listenPort })).toMatchObject({
        status: 200,
        body,
      });
    }
  });

  it("streams HTTP requests and responses with rewritten safe headers", async () => {
    let received:
      | {
          host?: string;
          cookie?: string;
          forwardedFor?: string;
          proto?: string;
          forwardedHost?: string;
        }
      | undefined;
    targetHandler = (req, res) => {
      received = {
        host: req.headers.host,
        cookie: req.headers.cookie,
        forwardedFor: req.headers["x-forwarded-for"] as string | undefined,
        proto: req.headers["x-forwarded-proto"] as string | undefined,
        forwardedHost: req.headers["x-forwarded-host"] as string | undefined,
      };
      res.statusCode = 201;
      res.setHeader("Connection", "keep-alive, x-target-hop");
      res.setHeader("Keep-Alive", "upstream-secret=17");
      res.setHeader("X-Target-Hop", "remove");
      res.setHeader("X-App", "kept");
      res.write("hello ");
      res.end("portal");
    };
    const portal = await portalService().open({ targetPort });
    const result = await httpCall({
      port: portal.listenPort,
      path: "/asset?q=1",
      headers: {
        Host: "portal.example:9999",
        Cookie: `openclaw_plugin_tab=secret; ${portalAuthCookie(portal)}`,
        Connection: "keep-alive, x-remove-me",
        "X-Remove-Me": "remove",
      },
    });

    expect(result).toMatchObject({ status: 201, body: "hello portal" });
    expect(result.headers["x-app"]).toBe("kept");
    expect(result.headers["x-target-hop"]).toBeUndefined();
    // Node may add its own connection-local Keep-Alive header; the upstream value must not pass.
    expect(result.headers["keep-alive"]).not.toBe("upstream-secret=17");
    expect(received).toMatchObject({
      host: `localhost:${targetPort}`,
      proto: "http",
      forwardedHost: "portal.example:9999",
    });
    expect(received?.cookie).toBeUndefined();
    expect(received?.forwardedFor).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1/u);
  });

  it("forwards only each target's prefixed cookies, never either portal auth cookie", async () => {
    const receivedCookiesA: Array<string | undefined> = [];
    targetHandler = (req, res) => {
      receivedCookiesA.push(req.headers.cookie);
      if (req.url === "/set") {
        res.setHeader("Set-Cookie", "session=a; Domain=target.example; Path=/; HttpOnly");
      }
      res.statusCode = 200;
      res.end("target-a");
    };
    const receivedCookiesB: Array<string | undefined> = [];
    const targetPortB = await listenTarget((req, res) => {
      receivedCookiesB.push(req.headers.cookie);
      if (req.url === "/set") {
        res.setHeader("Set-Cookie", "session=b; Domain=target.example; Path=/; HttpOnly");
      }
      res.statusCode = 200;
      res.end("target-b");
    });
    const service = portalService();
    const portalA = await service.open({ targetPort });
    const portalB = await service.open({ targetPort: targetPortB });
    const jar = new Map<string, string>();

    const initialA = await browserCall(jar, {
      port: portalA.listenPort,
      path: `/set?${portalA.tokenQuery}`,
    });
    const initialB = await browserCall(jar, {
      port: portalB.listenPort,
      path: `/set?${portalB.tokenQuery}`,
    });
    expect(initialA.headers["set-cookie"]).toContain(
      `oc_portal_${targetPort}_session=a; Path=/; HttpOnly`,
    );
    expect(initialB.headers["set-cookie"]).toContain(
      `oc_portal_${targetPortB}_session=b; Path=/; HttpOnly`,
    );
    expect(
      [...(initialA.headers["set-cookie"] ?? []), ...(initialB.headers["set-cookie"] ?? [])].join(
        "; ",
      ),
    ).not.toContain("Domain=");
    expect([...jar.keys()].filter((name) => name.startsWith("openclaw_portal"))).toEqual([
      `openclaw_portal_${portalA.listenPort}`,
      `openclaw_portal_${portalB.listenPort}`,
    ]);

    expect(await browserCall(jar, { port: portalA.listenPort })).toMatchObject({
      status: 200,
      body: "target-a",
    });
    expect(await browserCall(jar, { port: portalB.listenPort })).toMatchObject({
      status: 200,
      body: "target-b",
    });
    expect(receivedCookiesA).toEqual([undefined, "session=a"]);
    expect(receivedCookiesB).toEqual([undefined, "session=b"]);
  });

  it("forces no-referrer and never forwards a token-bearing referrer", async () => {
    let receivedReferer: string | undefined;
    targetHandler = (req, res) => {
      receivedReferer = req.headers.referer;
      // A hostile or careless target must not be able to widen the policy.
      res.setHeader("Referrer-Policy", "unsafe-url");
      res.statusCode = 200;
      res.end("proxied");
    };
    const portal = await portalService().open({ targetPort });
    const token = portal.tokenQuery.slice("openclaw_portal=".length);

    const result = await httpCall({
      port: portal.listenPort,
      headers: {
        Cookie: `openclaw_portal_${portal.listenPort}=${token}`,
        Referer: `http://127.0.0.1:${portal.listenPort}/?${portal.tokenQuery}`,
      },
    });

    expect(result.status).toBe(200);
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(receivedReferer).toBeUndefined();

    const unauthorized = await httpCall({ port: portal.listenPort });
    expect(unauthorized.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("streams POST bodies to the target", async () => {
    let body = "";
    targetHandler = (req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.once("end", () => {
        res.statusCode = 204;
        res.end();
      });
    };
    const portal = await portalService().open({ targetPort });
    const result = await httpCall({
      port: portal.listenPort,
      method: "POST",
      headers: {
        Cookie: portalAuthCookie(portal),
        "Content-Type": "text/plain",
      },
      body: "streamed request",
    });

    expect(result.status).toBe(204);
    expect(body).toBe("streamed request");
  });

  it("shows a retry page while the target is down", async () => {
    const unavailableTarget = createServer();
    await new Promise<void>((resolve) => {
      unavailableTarget.listen(0, "127.0.0.1", resolve);
    });
    const port = (unavailableTarget.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      unavailableTarget.close(() => resolve());
    });
    const portal = await portalService().open({ targetPort: port });

    const result = await httpCall({
      port: portal.listenPort,
      headers: { Cookie: portalAuthCookie(portal) },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain(`Waiting for the app on port ${port}…`);
    expect(result.body).toContain('http-equiv="refresh" content="2"');
  });

  it("reaches IPv6-only targets through the localhost dual-stack dial", async () => {
    // Node >=17 dev servers (Vite, Next.js) often bind ::1 only on "localhost".
    const v6Target = createServer((req, res) => {
      res.statusCode = 200;
      res.end("v6 proxied");
    });
    await new Promise<void>((resolve, reject) => {
      v6Target.once("error", reject);
      v6Target.listen(0, "::1", () => resolve());
    });
    try {
      const v6Port = (v6Target.address() as AddressInfo).port;
      const portal = await portalService().open({ targetPort: v6Port });
      const result = await httpCall({
        port: portal.listenPort,
        path: `/?${portal.tokenQuery}`,
      });
      expect(result).toMatchObject({ status: 200, body: "v6 proxied" });
    } finally {
      await new Promise<void>((resolve) => {
        v6Target.close(() => resolve());
      });
    }
  });

  it("splices WebSockets and destroys upgraded sockets and listeners on close", async () => {
    const service = portalService();
    const portal = await service.open({ targetPort });
    targetWebSocketSetCookie = "socket=ready; Domain=target.example; Path=/; HttpOnly";
    let upgradeCookies: string[] | undefined;
    const ws = new WebSocket(
      `ws://127.0.0.1:${portal.listenPort}/hmr?channel=dev&${portal.tokenQuery}`,
      { headers: { Cookie: "openclaw_plugin_tab=secret" } },
    );
    ws.once("upgrade", (response) => {
      upgradeCookies = response.headers["set-cookie"];
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const echoed = new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(webSocketMessageText(data)));
    });
    ws.send("hot reload");
    expect(await echoed).toBe("hot reload");
    expect(targetWebSocketPath).toBe("/hmr?channel=dev");
    expect(targetWebSocketCookie).toBeUndefined();
    expect(upgradeCookies).toEqual([`oc_portal_${targetPort}_socket=ready; Path=/; HttpOnly`]);

    const closed = new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
    await service.close(portal.id);
    await closed;
    await expect(httpCall({ port: portal.listenPort })).rejects.toThrow();
  });

  it("keeps portal A WebSocket authorized after portal B replaces the active URL", async () => {
    targetHandler = (_req, res) => {
      res.statusCode = 200;
      res.end("target-a");
    };
    const targetPortB = await listenTarget((_req, res) => {
      res.statusCode = 200;
      res.end("target-b");
    });
    const service = portalService();
    const portalA = await service.open({ targetPort });
    const portalB = await service.open({ targetPort: targetPortB });
    const jar = new Map<string, string>();
    await browserCall(jar, {
      port: portalA.listenPort,
      path: `/?${portalA.tokenQuery}`,
    });
    await browserCall(jar, {
      port: portalB.listenPort,
      path: `/?${portalB.tokenQuery}`,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${portalA.listenPort}/hmr?channel=dev`, {
      headers: { Cookie: cookieJarHeader(jar) },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const echoed = new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(webSocketMessageText(data)));
    });
    ws.send("portal-a");
    expect(await echoed).toBe("portal-a");
    expect(targetWebSocketPath).toBe("/hmr?channel=dev");
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  });
});
