import { once } from "node:events";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  rejectWebSocketUpgrade,
  type WebSocketUpgradeRejection,
} from "../shared/websocket-upgrade-reject.js";

describe("rejectWebSocketUpgrade", () => {
  it.each([
    [401, "Unauthorized"],
    [426, "Upgrade Required"],
    [503, "Service Unavailable"],
  ] as const)("writes exact HTTP %s bytes with and without a body", async (status, reason) => {
    for (const body of [undefined, { contentType: "text/plain; charset=utf-8", text: "é" }]) {
      const chunks: Buffer[] = [];
      const socket = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
      const closed = once(socket, "close");
      rejectWebSocketUpgrade(socket, { status, body });
      await closed;
      expect(Buffer.concat(chunks).toString()).toBe(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n` +
          (body ? "Content-Type: text/plain; charset=utf-8\r\nContent-Length: 2\r\n\r\né" : "\r\n"),
      );
      expect(socket.destroyed).toBe(true);
    }
  });

  it("flushes a custom reason and headers before destroying the socket", async () => {
    let response = "";
    let flush = () => {};
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        response += chunk.toString();
        flush = callback;
      },
    });
    const closed = once(socket, "close");
    const rejection: WebSocketUpgradeRejection = {
      status: 426,
      reason: "WebSocket Required",
      headers: { Upgrade: "websocket", "Retry-After": "1" },
    };
    rejectWebSocketUpgrade(socket, rejection);
    expect(response).toBe(
      "HTTP/1.1 426 WebSocket Required\r\nConnection: close\r\n" +
        "Upgrade: websocket\r\nRetry-After: 1\r\n\r\n",
    );
    expect(socket.destroyed).toBe(false);
    flush();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("destroys the socket when writing throws", () => {
    const socket = new Duplex({ read() {} });
    vi.spyOn(socket, "end").mockImplementation(() => {
      throw new Error("write failed");
    });
    expect(() => rejectWebSocketUpgrade(socket, { status: 401 })).toThrow("write failed");
    expect(socket.destroyed).toBe(true);
  });
});
