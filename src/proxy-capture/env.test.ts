// Proxy capture env tests cover environment variable generation for capture sessions.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDebugProxySettings, resolveEffectiveDebugProxyUrl } from "./env.js";

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
});

describe("resolveEffectiveDebugProxyUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not discover capture paths while disabled and retains configured URL precedence", () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv(OPENCLAW_DEBUG_PROXY_ENABLED, "0");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://ambient.example.test:8080");
    const existsSync = vi.spyOn(fs, "existsSync");

    expect(resolveEffectiveDebugProxyUrl()).toBeUndefined();
    expect(resolveEffectiveDebugProxyUrl(" http://configured.example.test:8080 ")).toBe(
      "http://configured.example.test:8080",
    );
    expect(existsSync).not.toHaveBeenCalled();

    vi.stubEnv(OPENCLAW_DEBUG_PROXY_ENABLED, "1");
    expect(resolveEffectiveDebugProxyUrl()).toBe("http://ambient.example.test:8080");
    expect(resolveEffectiveDebugProxyUrl("http://configured.example.test:8080")).toBe(
      "http://configured.example.test:8080",
    );
    vi.stubEnv(OPENCLAW_DEBUG_PROXY_ENABLED, "0");
    expect(resolveEffectiveDebugProxyUrl()).toBeUndefined();
  });
});
