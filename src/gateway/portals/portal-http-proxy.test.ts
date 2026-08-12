import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

type HttpResult = {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
};

let targetPort = 0;
let targetHandler: (req: IncomingMessage, res: ServerResponse) => void;
const targetServer = createServer((req, res) => targetHandler(req, res));
const targetWss = new WebSocketServer({ server: targetServer });
const services = new Set<GatewayPortalService>();

beforeAll(async () => {
  targetWss.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject);
    targetServer.listen(0, "127.0.0.1", () => resolve());
  });
  targetPort = (targetServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await Promise.all([...services].map((service) => service.closeAll()));
  services.clear();
});

afterAll(async () => {
  targetWss.close();
  await new Promise<void>((resolve) => targetServer.close(() => resolve()));
});

function portalService() {
  const service = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers: [] });
  services.add(service);
  return service;
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

describe("portal HTTP proxy", () => {
  it("exchanges the URL token for a private cookie", async () => {
    const portal = await portalService().open({ targetPort, title: "App" });

    const unauthorized = await httpCall({ port: portal.listenPort });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toContain("This portal is private");
    expect(unauthorized.body).not.toContain(portal.tokenQuery);

    const authorized = await httpCall({
      port: portal.listenPort,
      path: `/preview?x=1&${portal.tokenQuery}`,
    });
    expect(authorized.status).toBe(302);
    expect(authorized.headers.location).toBe("/preview?x=1");
    expect(authorized.headers["set-cookie"]?.[0]).toContain("HttpOnly; SameSite=Lax; Path=/");
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
    const token = portal.tokenQuery.slice("openclaw_portal=".length);
    const result = await httpCall({
      port: portal.listenPort,
      path: "/asset?q=1",
      headers: {
        Host: "portal.example:9999",
        Cookie: `app=ok; openclaw_portal=${token}; theme=dark`,
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
      host: `127.0.0.1:${targetPort}`,
      cookie: "app=ok; theme=dark",
      proto: "http",
      forwardedHost: "portal.example:9999",
    });
    expect(received?.forwardedFor).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1/u);
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
    const token = portal.tokenQuery.slice("openclaw_portal=".length);
    const result = await httpCall({
      port: portal.listenPort,
      method: "POST",
      headers: {
        Cookie: `openclaw_portal=${token}`,
        "Content-Type": "text/plain",
      },
      body: "streamed request",
    });

    expect(result.status).toBe(204);
    expect(body).toBe("streamed request");
  });

  it("shows a retry page while the target is down", async () => {
    const unavailableTarget = createServer();
    await new Promise<void>((resolve) => unavailableTarget.listen(0, "127.0.0.1", resolve));
    const port = (unavailableTarget.address() as AddressInfo).port;
    await new Promise<void>((resolve) => unavailableTarget.close(() => resolve()));
    const portal = await portalService().open({ targetPort: port });
    const token = portal.tokenQuery.slice("openclaw_portal=".length);

    const result = await httpCall({
      port: portal.listenPort,
      headers: { Cookie: `openclaw_portal=${token}` },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain(`Waiting for the app on port ${port}…`);
    expect(result.body).toContain('http-equiv="refresh" content="2"');
  });

  it("splices WebSockets and destroys upgraded sockets and listeners on close", async () => {
    const service = portalService();
    const portal = await service.open({ targetPort });
    const ws = new WebSocket(`ws://127.0.0.1:${portal.listenPort}/hmr?${portal.tokenQuery}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const echoed = new Promise<string>((resolve) =>
      ws.once("message", (data) => resolve(data.toString())),
    );
    ws.send("hot reload");
    expect(await echoed).toBe("hot reload");

    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await service.close(portal.id);
    await closed;
    await expect(httpCall({ port: portal.listenPort })).rejects.toThrow();
  });
});
