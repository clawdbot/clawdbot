import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlRequestTailer } from "../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mjs";
import { readPositiveIntEnv } from "../../scripts/e2e/lib/codex-media-path/limits.mjs";
import { waitForWebSocketOpen } from "../../scripts/e2e/lib/codex-media-path/open-websocket.mjs";

const tempRoots: string[] = [];
const writeConfigPath = path.resolve("scripts/e2e/lib/codex-media-path/write-config.mjs");

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-codex-media-path-"));
  tempRoots.push(root);
  return root;
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function runWriteConfig(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [writeConfigPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_TEST_WORKSPACE_DIR: path.join(root, "workspace"),
      PORT: "18790",
      ...env,
    },
  });
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

describe("codex media path limits", () => {
  it("rejects loose numeric env values instead of parsing prefixes", () => {
    expect(() =>
      readPositiveIntEnv("OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS", 180, {
        OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS: 1e3");
    expect(() =>
      readPositiveIntEnv("OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES", 2 * 1024 * 1024, {
        OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES: "64bytes",
      }),
    ).toThrow("invalid OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES: 64bytes");
  });

  it("writes strict positive timeout and port values into generated config", () => {
    const root = makeTempRoot();
    const result = runWriteConfig(root, {
      OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS: "240",
      PORT: "19002",
    });

    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
    expect(config.gateway.port).toBe(19002);
    expect(config.agents.defaults.timeoutSeconds).toBe(240);
    expect(config.plugins.entries.codex.config.appServer.requestTimeoutMs).toBe(240_000);
  });

  it("rejects loose write-config timeout env values", () => {
    const root = makeTempRoot();
    const result = runWriteConfig(root, {
      OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS: "1e3",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS: 1e3");
  });
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
