// Whatsapp tests cover transport-confirmed Baileys socket shutdown.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { closeWhatsAppSocketAndWait } from "./socket-close.js";

describe("closeWhatsAppSocketAndWait", () => {
  it("closes the underlying transport when Baileys end resolves while it remains open", async () => {
    let closed = false;
    const sock = {
      end: vi.fn().mockResolvedValue(undefined),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };

    await closeWhatsAppSocketAndWait(sock as never, "test close");

    expect(sock.end).toHaveBeenCalledOnce();
    expect(sock.ws.close).toHaveBeenCalledOnce();
    expect(sock.ws.isClosed).toBe(true);
  });

  it("waits for the asynchronous WebSocket close handshake", async () => {
    let closed = false;
    let closing = false;
    const ws = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      readonly isClosed: boolean;
      readonly isClosing: boolean;
    };
    Object.defineProperties(ws, {
      isClosed: { get: () => closed },
      isClosing: { get: () => closing },
    });
    ws.close = vi.fn(() => {
      closing = true;
      setImmediate(() => {
        closed = true;
        closing = false;
        ws.emit("close");
      });
    });
    const sock = { end: vi.fn(), ws };

    await closeWhatsAppSocketAndWait(sock as never, "test close");

    expect(sock.ws.close).toHaveBeenCalledOnce();
    expect(sock.ws.isClosed).toBe(true);
  });

  it("bounds Baileys teardown after the transport is already closed", async () => {
    vi.useFakeTimers();
    const ws = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      isClosed: boolean;
      isClosing: boolean;
    };
    ws.close = vi.fn();
    ws.isClosed = true;
    ws.isClosing = false;
    const sock = { end: vi.fn(() => new Promise<void>(() => {})), ws };

    try {
      const closeTask = closeWhatsAppSocketAndWait(sock as never, "test close");
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(closeTask).resolves.toBeUndefined();
      expect(ws.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when neither Baileys nor the transport confirms closure", async () => {
    const ws = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      isClosed: boolean;
      isClosing: boolean;
    };
    ws.close = vi.fn().mockRejectedValue(new Error("close failed"));
    ws.isClosed = false;
    ws.isClosing = false;
    const sock = {
      end: vi.fn().mockResolvedValue(undefined),
      ws,
    };

    await expect(closeWhatsAppSocketAndWait(sock as never, "test close")).rejects.toThrow(
      "socket close could not be confirmed",
    );
  });
});
