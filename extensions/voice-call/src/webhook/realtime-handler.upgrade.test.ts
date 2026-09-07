import { once } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import { CallManager } from "../manager.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

// The published minimum host has no WebSocket SDK subpath at all.
vi.mock("openclaw/plugin-sdk/websocket-runtime", () => {
  throw new Error("websocket-runtime is not exported by OpenClaw 2026.9.2");
});

function createHandler() {
  const config = VoiceCallConfigSchema.parse({ realtime: { enabled: true } });
  const resolveRegistration = vi.fn((): never => {
    throw new Error("Rejected upgrades must not acquire a provider");
  });
  const handler = new RealtimeCallHandler(
    config.realtime,
    new CallManager(config),
    resolveRegistration,
    "/voice/webhook",
    { connect() {}, disconnect() {}, retire() {} },
  );
  return { handler, resolveRegistration };
}

function upgradeRequest() {
  const transport = new Socket();
  const request = new IncomingMessage(transport);
  request.url = "/voice/stream/realtime/invalid-token";
  return { request, transport };
}

describe("realtime upgrade rejection on the minimum SDK", () => {
  it.each([
    [401, "Unauthorized"],
    [503, "Service Unavailable"],
  ] as const)(
    "flushes HTTP %s before closing without acquiring a provider",
    async (status, reason) => {
      const { handler, resolveRegistration } = createHandler();
      const { request, transport } = upgradeRequest();
      const shutdown = createDeferred<void>();
      const closing = status === 503 ? handler.close(shutdown.promise) : undefined;
      let flush = () => {};
      let response = "";
      const socket = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          response += chunk.toString();
          flush = callback;
        },
      });
      const closed = once(socket, "close");
      try {
        handler.handleWebSocketUpgrade(request, socket, Buffer.alloc(0));
        expect(response).toBe(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        expect(socket.destroyed).toBe(false);
        expect(resolveRegistration).not.toHaveBeenCalled();
        flush();
        await closed;
        expect(socket.destroyed).toBe(true);
      } finally {
        flush();
        socket.destroy();
        transport.destroy();
        shutdown.resolve();
        await closing;
        await handler.close();
      }
    },
  );

  it("destroys the rejected socket and preserves a synchronous write failure", async () => {
    const { handler, resolveRegistration } = createHandler();
    const { request, transport } = upgradeRequest();
    const socket = new Duplex({ read() {} });
    const failure = new Error("synthetic socket write failure");
    vi.spyOn(socket, "end").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => handler.handleWebSocketUpgrade(request, socket, Buffer.alloc(0))).toThrow(
        failure,
      );
      expect(socket.destroyed).toBe(true);
      expect(resolveRegistration).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      transport.destroy();
      await handler.close();
    }
  });

  it("owns raw socket errors while rejection bytes are buffered", async () => {
    const { handler } = createHandler();
    const { request, transport } = upgradeRequest();
    let flush = () => {};
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        flush = callback;
      },
    });
    try {
      handler.handleWebSocketUpgrade(request, socket, Buffer.alloc(0));
      expect(() => socket.emit("error", new Error("synthetic raw socket failure"))).not.toThrow();
      expect(socket.destroyed).toBe(true);
    } finally {
      flush();
      socket.destroy();
      transport.destroy();
      await handler.close();
    }
  });
});
