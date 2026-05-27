import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForWebSocketOpen } from "../../scripts/e2e/lib/gateway-network/open-websocket.mjs";

class FakeWebSocket extends EventEmitter {
  terminated = false;
  closed = false;

  terminate(): void {
    this.terminated = true;
    queueMicrotask(() => {
      this.emit("error", new Error("socket abort after terminate"));
      this.emit("close");
    });
  }

  close(): void {
    this.closed = true;
  }
}

describe("gateway network WebSocket open guard", () => {
  it("consumes abort errors after open timeouts", async () => {
    const ws = new FakeWebSocket();
    const keepAlive = setTimeout(() => {}, 100);

    try {
      await expect(waitForWebSocketOpen(ws, 1)).rejects.toThrow("ws open timeout");
    } finally {
      clearTimeout(keepAlive);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.terminated).toBe(true);
    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
  });

  it("cleans listeners after successful opens", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws, 100);

    ws.emit("open");

    await expect(opened).resolves.toBeUndefined();
    expect(ws.terminated).toBe(false);
    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
  });
});
