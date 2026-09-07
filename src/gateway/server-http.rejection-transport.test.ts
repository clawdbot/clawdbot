import { once } from "node:events";
import { Agent, request, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";
import { readWebhookBodyOrReject } from "../plugin-sdk/webhook-request-guards.js";
import { createDeferredCore } from "../shared/deferred.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

describe("Gateway closing connection admission", () => {
  it("delivers an upgrade rejection after an ordinary response on a reused connection", async () => {
    const clients = new Set<never>();
    const resolvedAuth = { mode: "none" as const, allowTailscale: false };
    const server = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "",
      resolvedAuth,
      getRuntimeConfig: () => ({}),
      handleHooksRequest: async (_req, res) => {
        res.end("ready");
        return true;
      },
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      clients,
      resolvedAuth,
      preauthConnectionBudget: createPreauthConnectionBudget(),
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing listener");
    }
    const readResponse = (upgrade: boolean) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/socket",
            agent,
            headers: upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {},
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.once("error", reject);
            res.once("end", () =>
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.once("error", reject);
        req.end();
      });
    try {
      await expect(readResponse(false)).resolves.toEqual({ status: 200, body: "ready" });
      await expect(readResponse(true)).resolves.toEqual({
        status: 503,
        body: "Gateway websocket handlers unavailable",
      });
    } finally {
      agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      wss.close();
    }
  });

  it("contains browser socket errors while plugin upgrade routing is pending", async () => {
    const routing = createDeferredCore<Duplex>();
    const releaseRouting = createDeferredCore();
    const routed = createDeferredCore();
    const clients = new Set<never>();
    const resolvedAuth = { mode: "none" as const, allowTailscale: false };
    const server = createGatewayHttpServer({
      clients,
      controlUiEnabled: false,
      controlUiBasePath: "",
      resolvedAuth,
      getRuntimeConfig: () => ({}),
      handleHooksRequest: async (_req, res) => {
        res.end("still available");
        return true;
      },
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      clients,
      resolvedAuth,
      preauthConnectionBudget: createPreauthConnectionBudget(),
      shouldEnforcePluginGatewayAuth: () => false,
      handlePluginUpgrade: async (_req, socket) => {
        routing.resolve(socket);
        await releaseRouting.promise;
        routed.resolve();
        return true;
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing listener");
    }
    const browser = connect({ host: "127.0.0.1", port: address.port });
    let transport: Duplex | undefined;
    try {
      await once(browser, "connect");
      browser.write(
        "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      transport = await routing.promise;
      const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      expect(() => transport!.emit("error", reset)).not.toThrow();
      expect(transport.destroyed).toBe(true);
      releaseRouting.resolve();
      await routed.promise;
      expect(await (await fetch(`http://127.0.0.1:${address.port}/next`)).text()).toBe(
        "still available",
      );
    } finally {
      releaseRouting.resolve();
      browser.destroy();
      transport?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      wss.close();
    }
  });

  it.each([
    { route: "Gateway", queued: false },
    { route: "Gateway", queued: true },
    { route: "plugin", queued: false },
    { route: "plugin", queued: true },
    { route: "plugin stream", queued: true },
  ])(
    "preserves $route WebSocket pause after upgrade (queued=$queued)",
    async ({ route, queued }) => {
      let earlier: ServerResponse | undefined;
      let upgradeSeen = false;
      let transport: Duplex | undefined;
      let websocket: WebSocket | undefined;
      let stream: Duplex | undefined;
      const buffered = createDeferredCore();
      const clients = new Set<never>();
      const resolvedAuth = { mode: "none" as const, allowTailscale: false };
      const server = createGatewayHttpServer({
        clients,
        controlUiEnabled: false,
        controlUiBasePath: "",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        resolvedAuth,
        getRuntimeConfig: () => ({}),
        handleHooksRequest: async (_req, res) => {
          earlier = res;
          if (upgradeSeen) {
            res.end("earlier");
          }
          return true;
        },
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
      const accept = (ws: WebSocket) => {
        websocket = ws;
        if (route === "plugin stream") {
          stream = createWebSocketStream(ws, { highWaterMark: 1 });
          stream.once("readable", () => {
            ws.send("ready");
            buffered.resolve();
          });
        } else {
          ws.pause();
          ws.send("ready");
        }
      };
      wss.on("connection", accept);
      attachGatewayUpgradeHandler({
        httpServer: server,
        wss,
        clients,
        resolvedAuth,
        preauthConnectionBudget: createPreauthConnectionBudget(),
        handlePluginUpgrade: route.startsWith("plugin")
          ? async (req, socket, head) => {
              wss.handleUpgrade(req, socket, head, accept);
              if (route === "plugin stream") {
                await buffered.promise;
              }
              return true;
            }
          : undefined,
        shouldEnforcePluginGatewayAuth: () => false,
      });
      server.once("upgrade", (_req, socket) => {
        transport = socket;
        upgradeSeen = true;
        earlier?.end("earlier");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing listener");
      }
      const socket = connect({ host: "127.0.0.1", port: address.port });
      const ready = createDeferredCore();
      let wire = "";
      socket.on("data", (chunk) => {
        wire += chunk.toString();
        if (wire.endsWith("ready")) {
          ready.resolve();
        }
      });
      socket.on("error", ready.reject);
      const deadline = setTimeout(() => ready.reject(new Error("client deadline")), 3000);
      try {
        socket.write(
          (queued ? "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n" : "") +
            "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdC1rZXktMDEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        if (route === "plugin stream") {
          socket.write(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x79]));
        }
        await ready.promise;
        expect(wire.match(/HTTP\/1\.1 \d{3}/g)).toEqual(
          queued ? ["HTTP/1.1 200", "HTTP/1.1 101"] : ["HTTP/1.1 101"],
        );
        expect(websocket!.isPaused).toBe(true);
        expect(transport!.isPaused()).toBe(true);
        if (stream) {
          expect(stream.read().toString()).toBe("x");
        }
        const message = once(websocket!, "message");
        socket.write(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x79]));
        websocket!.resume();
        expect((await message)[0].toString()).toBe("x");
      } finally {
        clearTimeout(deadline);
        socket.destroy();
        stream?.destroy();
        websocket?.terminate();
        transport?.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        wss.close();
      }
    },
  );

  it.each([
    { version: "1.0", expectation: "100-continue", status: 200, interim: false },
    { version: "1.0", expectation: "unsupported", status: 200, interim: false },
    { version: "1.1", expectation: "100-Continue", status: 200, interim: true },
    { version: "1.1", expectation: "other, 100-continue", status: 200, interim: true },
    { version: "1.1", expectation: "unsupported", status: 417, interim: false },
  ])(
    "preserves Node Expect admission for HTTP/$version $expectation",
    async ({ version, expectation, status, interim }) => {
      const dispatched: string[] = [];
      const server = createGatewayHttpServer({
        clients: new Set(),
        controlUiEnabled: false,
        controlUiBasePath: "",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        resolvedAuth: { mode: "none", allowTailscale: false },
        getRuntimeConfig: () => ({}),
        handleHooksRequest: async (req, res) => {
          dispatched.push(req.url!);
          res.end("accepted");
          return true;
        },
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing listener");
      }
      const socket = connect({ host: "127.0.0.1", port: address.port });
      const chunks: Buffer[] = [];
      const errors: string[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", (error) => errors.push(error.message));
      const closed = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      const deadline = setTimeout(() => {
        errors.push("client deadline");
        socket.destroy();
      }, 3000);
      try {
        socket.write(
          `GET /expect HTTP/${version}\r\nHost: localhost\r\nExpect: ${expectation}\r\nConnection: close\r\n\r\n`,
        );
        await closed;
        const wire = Buffer.concat(chunks).toString();
        expect(errors).toEqual([]);
        expect(wire.match(/HTTP\/1\.1 \d{3}/g)).toEqual(
          interim ? ["HTTP/1.1 100", `HTTP/1.1 ${status}`] : [`HTTP/1.1 ${status}`],
        );
        expect(dispatched).toEqual(status === 200 ? ["/expect"] : []);
        expect(wire.endsWith(status === 200 ? "accepted" : "\r\n\r\n")).toBe(true);
      } finally {
        clearTimeout(deadline);
        socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  it.each(["ordinary", "upgrade", "continue", "expectation", "connect"])(
    "does not route a pipelined %s request after a rejected upload",
    async (next) => {
      const dispatched: string[] = [];
      const upgrades = vi.fn(async () => true);
      const tasks: Promise<unknown>[] = [];
      const clients = new Set<never>();
      const resolvedAuth = { mode: "none" as const, allowTailscale: false };
      const server = createGatewayHttpServer({
        clients,
        controlUiEnabled: false,
        controlUiBasePath: "",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        resolvedAuth,
        getRuntimeConfig: () => ({}),
        handleHooksRequest: async (req, res) => {
          dispatched.push(req.url!);
          const task = readWebhookBodyOrReject({ req, res, maxBytes: 256 * 1024 });
          tasks.push(task);
          await task;
          return true;
        },
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
      attachGatewayUpgradeHandler({
        httpServer: server,
        wss,
        clients,
        resolvedAuth,
        preauthConnectionBudget: createPreauthConnectionBudget(),
        handlePluginUpgrade: upgrades,
        shouldEnforcePluginGatewayAuth: () => false,
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing listener");
      }
      const socket = connect({ host: "127.0.0.1", port: address.port });
      const received: Buffer[] = [];
      const errors: string[] = [];
      const closed = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("error", (error) => errors.push(error.message));
      const deadline = setTimeout(() => {
        errors.push("client deadline");
        socket.destroy();
      }, 3000);
      try {
        const payload = "x".repeat(1024 * 1024 + 1);
        const headers =
          next === "upgrade"
            ? "Connection: Upgrade\r\nUpgrade: websocket\r\n"
            : next === "continue"
              ? "Expect: 100-continue\r\nContent-Length: 1\r\n"
              : next === "expectation"
                ? "Expect: unsupported\r\n"
                : "";
        const requestLine =
          next === "connect" ? "CONNECT localhost:80 HTTP/1.1" : "GET /second HTTP/1.1";
        socket.write(
          "POST /first HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n" +
            payload.length.toString(16) +
            "\r\n" +
            payload +
            "\r\n0\r\n\r\n" +
            requestLine +
            "\r\nHost: localhost\r\n" +
            headers +
            "\r\n",
        );
        await closed;
        const wire = Buffer.concat(received).toString();
        expect(errors).toEqual([]);
        expect(wire).toMatch(/^HTTP\/1\.1 413 /);
        expect(wire).toContain("X-Content-Type-Options: nosniff");
        expect(wire.split("\r\n\r\n")[1]).toBe("Payload too large");
        expect(dispatched).toEqual(["/first"]);
        expect(upgrades).not.toHaveBeenCalled();
      } finally {
        clearTimeout(deadline);
        socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        wss.close();
        await Promise.all(tasks);
      }
    },
  );
});
