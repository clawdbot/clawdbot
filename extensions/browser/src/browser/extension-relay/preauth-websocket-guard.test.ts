import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { handlePreAuthWebSocketUpgrade } from "./preauth-websocket-guard.js";
import { EXTENSION_RELAY_MAX_PAYLOAD_BYTES } from "./relay-server.js";

describe("pre-auth WebSocket head admission", () => {
  it("rejects oversized upgrade-head auth data before challenge or bridge promotion", async () => {
    let writtenBytes = 0;
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        writtenBytes += chunk.byteLength;
        callback();
      },
    });
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/extension";
    req.headers = {
      host: "127.0.0.1",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
    });
    const handleUpgrade = vi.spyOn(wss, "handleUpgrade");
    const onUpgrade = vi.fn((ws: WebSocket) => ws.on("error", () => {}));
    // Supply Node's exact head argument: client TCP writes cannot choose its size.
    const head = Buffer.alloc(17 * 1024 + 1);
    try {
      const accepted = handlePreAuthWebSocketUpgrade({ wss, req, socket, head, onUpgrade });

      expect(head.byteLength).toBe(17_409);
      expect(accepted).toBe(false);
      expect(handleUpgrade.mock.calls.length).toBe(0);
      expect(onUpgrade.mock.calls.length).toBe(0);
      expect(wss.clients.size).toBe(0);
      expect(writtenBytes).toBe(0);
    } finally {
      for (const client of wss.clients) {
        client.terminate();
      }
      socket.destroy();
      req.destroy();
      handleUpgrade.mockRestore();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
