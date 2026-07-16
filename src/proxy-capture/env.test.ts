// Proxy capture env tests cover environment variable generation for capture sessions.
import { describe, expect, it } from "vitest";
import { applyDebugProxyEnv, resolveDebugProxySettings } from "./env.js";

const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";
const OPENCLAW_DEBUG_PROXY_SESSION_ID = "OPENCLAW_DEBUG_PROXY_SESSION_ID";

describe("resolveDebugProxySettings", () => {
  it("keeps an implicit debug proxy session id stable within one process", () => {
    const env = {
      [OPENCLAW_DEBUG_PROXY_ENABLED]: "1",
    } satisfies NodeJS.ProcessEnv;

    const first = resolveDebugProxySettings(env);
    const second = resolveDebugProxySettings(env);

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("prefers an explicit session id from the environment", () => {
    const settings = resolveDebugProxySettings({
      [OPENCLAW_DEBUG_PROXY_ENABLED]: "1",
      [OPENCLAW_DEBUG_PROXY_SESSION_ID]: "session-explicit",
    });

    expect(settings.sessionId).toBe("session-explicit");
  });

  it("retains deprecated capture storage settings for Plugin SDK compatibility", () => {
    const settings = resolveDebugProxySettings({
      OPENCLAW_DEBUG_PROXY_DB_PATH: "/tmp/legacy-capture.sqlite",
      OPENCLAW_DEBUG_PROXY_BLOB_DIR: "/tmp/legacy-capture-blobs",
    });

    expect(settings.dbPath).toBe("/tmp/legacy-capture.sqlite");
    expect(settings.blobDir).toBe("/tmp/legacy-capture-blobs");
  });

  it("does not pass obsolete capture storage overrides to child processes", () => {
    const env = applyDebugProxyEnv(
      {
        OPENCLAW_DEBUG_PROXY_DB_PATH: "/tmp/legacy-capture.sqlite",
        OPENCLAW_DEBUG_PROXY_BLOB_DIR: "/tmp/legacy-capture-blobs",
      },
      {
        proxyUrl: "http://127.0.0.1:7799",
        sessionId: "session-child",
      },
    );

    expect(env.OPENCLAW_DEBUG_PROXY_DB_PATH).toBeUndefined();
    expect(env.OPENCLAW_DEBUG_PROXY_BLOB_DIR).toBeUndefined();
  });
});
