import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";
import { TINY_PNG_BASE64, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { GatewayClient } from "../../../../src/gateway/client.js";
import type { DeviceIdentity } from "../../../../src/infra/device-identity.js";

export async function waitForHotReloadFact<T>(
  label: string,
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) {
      return result;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export type HotReloadGateway = Pick<QaGatewayChild, "wsUrl" | "token" | "runtimeEnv">;
export type HotReloadConnection = {
  client: GatewayClient;
  bootId: string;
  closes: number;
  hellos: number;
  pluginSurfaceUrls: Record<string, string>;
  events: Array<{ event: string; payload?: unknown }>;
};

export async function connectHotReloadClient(
  gateway: HotReloadGateway,
  options: {
    identity?: DeviceIdentity;
    caps?: string[];
    commands?: string[];
    onEvent?: (event: { event: string; payload?: unknown }) => void;
  } = {},
): Promise<HotReloadConnection> {
  const events: HotReloadConnection["events"] = [];
  const node = options.identity !== undefined;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        connection.client.stop();
        reject(error);
      } else {
        resolve(connection);
      }
    };
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      deviceIdentity: options.identity ?? null,
      role: node ? "node" : "operator",
      clientName: node ? "openclaw-ios" : "gateway-client",
      clientDisplayName: node ? "Hot reload synthetic node" : "Hot reload proof",
      clientVersion: "1.0.0",
      platform: node ? "iOS" : process.platform,
      mode: node ? "node" : "backend",
      scopes: node ? [] : ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
      caps: node ? (options.caps ?? ["browser"]) : undefined,
      commands: node ? (options.commands ?? ["browser.proxy"]) : undefined,
      onHelloOk: (hello) => {
        if (!hello.server.bootId) {
          finish(new Error("Gateway hello omitted bootId"));
          return;
        }
        connection.hellos += 1;
        connection.bootId = hello.server.bootId;
        connection.pluginSurfaceUrls = hello.pluginSurfaceUrls ?? {};
        finish();
      },
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => {
        connection.closes += 1;
        finish(new Error(`Gateway closed before hello: ${code} ${reason}`));
      },
      onEvent: (event) => {
        events.push(event);
        options.onEvent?.(event);
      },
    });
    const connection: HotReloadConnection = {
      client,
      bootId: "",
      closes: 0,
      hellos: 0,
      pluginSurfaceUrls: {},
      events,
    };
    const timeout = setTimeout(() => finish(new Error("Gateway connection timed out")), 20_000);
    timeout.unref();
    connection.client.start();
  });
}

export async function startHotReloadUpstreams(mockBaseUrl: string) {
  const githubTokens: string[] = [randomUUID(), randomUUID()];
  const githubRequests: number[] = [];
  const relayRequests: Array<{ route: string; signed: boolean }> = [];
  let faviconRequests = 0;
  let relayDelayMs = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (value: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (url.pathname.startsWith("/github/")) {
        const generation = githubTokens.indexOf(
          String(req.headers.authorization).replace(/^Bearer /, ""),
        );
        githubRequests.push(generation);
        if (url.pathname === "/github/repos/qa/reload") {
          json({
            private: false,
            visibility: "public",
            url: "https://api.github.com/repos/qa/reload",
          });
        } else {
          json({
            title: `Fixture credential generation ${generation}`,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            state: "open",
            repository_url: "https://api.github.com/repos/qa/reload",
            user: { login: "qa-fixture" },
          });
        }
        return;
      }
      if (url.pathname === "/favicon.ico") {
        faviconRequests += 1;
        res.setHeader("content-type", "image/png");
        res.end(Buffer.from(TINY_PNG_BASE64, "base64"));
        return;
      }
      if (url.pathname === "/widget") {
        res.setHeader("content-type", "text/html");
        res.end(
          '<!doctype html><title>Hot reload widget</title><p id="proof">Synthetic embedded page</p><button>Hot reload action</button><script>document.body.dataset.scriptRan="yes"</script>',
        );
        return;
      }
      if (url.pathname.endsWith("/v1/push/send")) {
        for await (const chunk of req) {
          void chunk;
          /* Drain the real signed relay request. */
        }
        relayRequests.push({
          route: url.pathname,
          signed: Boolean(req.headers["x-openclaw-gateway-signature"]),
        });
        if (relayDelayMs) {
          await delay(relayDelayMs);
        }
        json({ ok: true, status: 200, apnsId: randomUUID(), environment: "sandbox" });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const upstream = await fetch(`${mockBaseUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        ...(body ? { body } : {}),
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => res.setHeader(name, value));
      assert(upstream.body);
      Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>).pipe(res);
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    githubTokens,
    githubRequests,
    relayRequests,
    get faviconRequests() {
      return faviconRequests;
    },
    setRelayDelay(ms: number) {
      relayDelayMs = ms;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
