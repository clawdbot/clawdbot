import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClientTransport } from "./transport.js";

describe("GatewayClientTransport live WebSocket lifecycle", () => {
  it("keeps healthy concurrent event readers alive when another subscriber fails", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "sdk-live-websocket", ts: Date.now() },
        }),
      );
      socket.on("message", (raw) => {
        const request = JSON.parse(rawDataToString(raw)) as { id: string; method: string };
        if (request.method !== "connect") {
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 1,
              server: { version: "sdk-live", connId: "sdk-live-connection" },
              features: { methods: ["connect"], events: ["sessions.changed"] },
              snapshot: {
                presence: [],
                health: {},
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 1,
              },
              auth: { role: "operator", scopes: [] },
              policy: { maxPayload: 262_144, maxBufferedBytes: 262_144, tickIntervalMs: 30_000 },
            },
          }),
        );
      });
    });

    const transport = new GatewayClientTransport({
      url: `ws://127.0.0.1:${port}`,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    try {
      await transport.connect();
      const failedStream = transport.events(() => {
        throw new Error("subscriber filter failed");
      });
      const failed = failedStream[Symbol.asyncIterator]();
      const healthy = transport.events()[Symbol.asyncIterator]();
      const failedRead = expect(failed.next()).rejects.toThrow("subscriber filter failed");
      const first = healthy.next();
      const second = healthy.next();
      const socket = [...server.clients][0];
      if (!socket) {
        throw new Error("expected a live Gateway WebSocket connection");
      }
      for (const seq of [1, 2]) {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "sessions.changed",
            seq,
            payload: { seq },
          }),
        );
      }

      await failedRead;
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { done: false, value: { event: "sessions.changed", payload: { seq: 1 } } },
        { done: false, value: { event: "sessions.changed", payload: { seq: 2 } } },
      ]);
      await healthy.return?.();
    } finally {
      await transport.close();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
