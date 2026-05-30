import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForWebSocketOpen } from "../../scripts/e2e/lib/websocket-open.mjs";

class FakeWebSocket extends EventEmitter {
  terminated = false;

  terminate(): void {
    this.terminated = true;
    queueMicrotask(() => {
      this.emit("error", new Error("socket abort after terminate"));
      this.emit("close");
    });
  }
}

describe("E2E WebSocket open guard", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

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

  it("uses caller-specific timeout messages", async () => {
    const ws = new FakeWebSocket();
    const keepAlive = setTimeout(() => {}, 100);

    try {
      await expect(waitForWebSocketOpen(ws, 1, "gateway ws open timeout")).rejects.toThrow(
        "gateway ws open timeout",
      );
    } finally {
      clearTimeout(keepAlive);
    }
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
