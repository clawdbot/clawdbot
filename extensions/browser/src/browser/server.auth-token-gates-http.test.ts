import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isAuthorizedBrowserRequest } from "./http-auth.js";
import { getBrowserTestFetch, type BrowserTestFetch } from "./test-fetch.js";

let server: ReturnType<typeof createServer> | null = null;
let port = 0;
let realFetch: BrowserTestFetch;

describe("browser control HTTP auth", () => {
  beforeAll(() => {
    realFetch = getBrowserTestFetch();
  });

  beforeEach(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!isAuthorizedBrowserRequest(req, { token: "browser-control-secret" })) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Unauthorized");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("server address missing");
    }
    port = addr.port;
  });

  afterEach(async () => {
    const current = server;
    server = null;
    if (!current) {
      return;
    }
    await new Promise<void>((resolve) => current.close(() => resolve()));
  });

  it("requires bearer auth for standalone browser HTTP routes", async () => {
    const base = `http://127.0.0.1:${port}`;

    const missingAuth = await realFetch(`${base}/`);
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.text()).toContain("Unauthorized");

    const badAuth = await realFetch(`${base}/`, {
      headers: {
        Authorization: "Bearer wrong-token",
      },
    });
    expect(badAuth.status).toBe(401);

    const ok = await realFetch(`${base}/`, {
      headers: {
        Authorization: "Bearer browser-control-secret",
      },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it("rejects bearer auth when password mode is active", async () => {
    const base = `http://127.0.0.1:${port}`;

    server?.removeAllListeners("request");
    server?.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (!isAuthorizedBrowserRequest(req, { password: "browser-password" })) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
      res.statusCode = 200;
      res.end("ok");
    });

    const bearer = await realFetch(`${base}/`, {
      headers: {
        Authorization: "Bearer browser-control-secret",
      },
    });
    expect(bearer.status).toBe(401);

    const password = await realFetch(`${base}/`, {
      headers: {
        "x-openclaw-password": "browser-password",
      },
    });
    expect(password.status).toBe(200);
  });

  it("rejects password auth when token mode is active", async () => {
    const base = `http://127.0.0.1:${port}`;

    const password = await realFetch(`${base}/`, {
      headers: {
        "x-openclaw-password": "browser-control-secret",
      },
    });
    expect(password.status).toBe(401);
  });
});
