import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { serverStopSpy, spawnMock } = vi.hoisted(() => ({
  serverStopSpy: vi.fn(async () => undefined),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../proxy-capture/proxy-server.js", () => ({
  startDebugProxyServer: vi.fn(async () => ({
    proxyUrl: "http://127.0.0.1:7799",
    stop: serverStopSpy,
  })),
}));

describe("proxy cli runtime", () => {
  const envKeys = [
    "OPENCLAW_DEBUG_PROXY_DB_PATH",
    "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
    "OPENCLAW_DEBUG_PROXY_CERT_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-cli-runtime-"));
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_CERT_DIR = path.join(tempDir, "certs");
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID;
    serverStopSpy.mockClear();
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { closeDebugProxyCaptureStore } = await import("../proxy-capture/store.sqlite.js");
    closeDebugProxyCaptureStore();
    vi.resetModules();
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stops the proxy server and ends the session when child spawn fails", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    });

    const { runDebugProxyRunCommand } = await import("./proxy-cli.runtime.js");
    const { getDebugProxyCaptureStore } = await import("../proxy-capture/store.sqlite.js");

    await expect(
      runDebugProxyRunCommand({
        commandArgs: ["does-not-exist"],
      }),
    ).rejects.toThrow("spawn failed");

    expect(serverStopSpy).toHaveBeenCalledTimes(1);

    const store = getDebugProxyCaptureStore(
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH!,
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR!,
    );
    const [session] = store.listSessions(5);
    expect(session?.mode).toBe("proxy-run");
    expect(session?.endedAt).toEqual(expect.any(Number));
  });
});
