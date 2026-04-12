import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("debug proxy runtime", () => {
  const envKeys = [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_DB_PATH",
    "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_SOURCE_PROCESS",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-runtime-"));
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "runtime-test-session";
    process.env.OPENCLAW_DEBUG_PROXY_SOURCE_PROCESS = "runtime-test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("captures ambient global fetch calls when debug proxy mode is enabled", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"ok":true}', { status: 200 }),
    ) as typeof fetch;

    const runtime = await import("./runtime.js");
    const storeModule = await import("./store.sqlite.js");
    runtime.initializeDebugProxyCapture("test");
    await globalThis.fetch("https://api.minimax.io/anthropic/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.finalizeDebugProxyCapture();

    const store = storeModule.getDebugProxyCaptureStore(
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH!,
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR!,
    );
    const events = store.getSessionEvents("runtime-test-session", 20);
    expect(events.some((event) => event.host === "api.minimax.io")).toBe(true);
    expect(events.some((event) => event.kind === "request")).toBe(true);
    expect(events.some((event) => event.kind === "response")).toBe(true);
    store.close();
  });
});
