import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlRequestTailer } from "../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mjs";
import { waitForWebSocketOpen } from "../../scripts/e2e/lib/codex-media-path/open-websocket.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-codex-media-path-"));
  tempRoots.push(root);
  return root;
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("codex media path JSONL tailer", () => {
  it("keeps parsed app-server requests and reads only appended lines", () => {
    const logPath = path.join(makeTempRoot(), "app-server.jsonl");
    const tailer = createJsonlRequestTailer(logPath, { maxReadBytes: 1024, historyLimit: 10 });

    expect(tailer.read()).toEqual([]);

    writeFileSync(logPath, jsonl({ method: "initialize" }));
    expect(tailer.read()).toEqual([{ method: "initialize" }]);

    appendFileSync(logPath, JSON.stringify({ method: "turn/start" }));
    expect(tailer.read()).toEqual([{ method: "initialize" }]);

    appendFileSync(logPath, "\n");
    expect(tailer.read()).toEqual([{ method: "initialize" }, { method: "turn/start" }]);
  });

  it("starts from a bounded tail of oversized logs", () => {
    const logPath = path.join(makeTempRoot(), "app-server.jsonl");
    const lastLine = jsonl({ method: "turn/start" });
    writeFileSync(logPath, `${"x".repeat(256)}\n${jsonl({ method: "old" })}${lastLine}`);

    const tailer = createJsonlRequestTailer(logPath, {
      maxReadBytes: lastLine.length + 2,
      historyLimit: 10,
    });

    expect(tailer.read()).toEqual([{ method: "turn/start" }]);
  });

  it("keeps a complete line when the bounded tail starts on its boundary", () => {
    const logPath = path.join(makeTempRoot(), "app-server.jsonl");
    const lastLine = jsonl({ method: "turn/start" });
    writeFileSync(logPath, `${"x".repeat(256)}\n${lastLine}`);

    const tailer = createJsonlRequestTailer(logPath, {
      maxReadBytes: lastLine.length,
      historyLimit: 10,
    });

    expect(tailer.read()).toEqual([{ method: "turn/start" }]);
  });

  it("resets request history when the app-server log is truncated", () => {
    const logPath = path.join(makeTempRoot(), "app-server.jsonl");
    const tailer = createJsonlRequestTailer(logPath, { maxReadBytes: 1024, historyLimit: 10 });

    writeFileSync(logPath, jsonl({ method: "initialize", payload: "long enough to rotate" }));
    expect(tailer.read()).toEqual([{ method: "initialize", payload: "long enough to rotate" }]);

    writeFileSync(logPath, jsonl({ method: "turn/start" }));
    expect(tailer.read()).toEqual([{ method: "turn/start" }]);
  });
});

describe("codex media path WebSocket open guard", () => {
  it("terminates sockets that never open", async () => {
    const ws = new FakeWebSocket();
    const keepAlive = setTimeout(() => {}, 100);

    try {
      await expect(waitForWebSocketOpen(ws, 1)).rejects.toThrow("gateway ws open timeout");
    } finally {
      clearTimeout(keepAlive);
    }

    expect(ws.terminated).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
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
