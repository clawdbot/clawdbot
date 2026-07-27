// Google tests cover oauth.http proxy-mode selection for the Gemini CLI OAuth
// token-exchange/identity calls (issue openclaw#46184).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_URL } from "./oauth.shared.js";

const fetchWithSsrFGuardMock = vi.fn();

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: (params: unknown) => fetchWithSsrFGuardMock(params),
  };
});

const { fetchWithTimeout } = await import("./oauth.http.js");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const savedEnv = new Map<string, string | undefined>();

type ProxyEnvOverrides = {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
};

function setProxyEnv(values: ProxyEnvOverrides): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
  if (values.HTTP_PROXY !== undefined) {
    process.env.HTTP_PROXY = values.HTTP_PROXY;
  }
  if (values.HTTPS_PROXY !== undefined) {
    process.env.HTTPS_PROXY = values.HTTPS_PROXY;
  }
  if (values.ALL_PROXY !== undefined) {
    process.env.ALL_PROXY = values.ALL_PROXY;
  }
  if (values.NO_PROXY !== undefined) {
    process.env.NO_PROXY = values.NO_PROXY;
  }
}

function lastGuardedOptions(): Record<string, unknown> {
  const call = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("Expected fetchWithSsrFGuard to be called");
  }
  return call as Record<string, unknown>;
}

describe("oauth.http fetchWithTimeout proxy selection", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
    }
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("{}", { status: 200 }),
      finalUrl: TOKEN_URL,
      release: async () => {},
    });
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  it("routes the Google token exchange through the env proxy when configured", async () => {
    setProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7897", HTTP_PROXY: "http://127.0.0.1:7897" });

    await fetchWithTimeout(TOKEN_URL, { method: "POST", body: "grant_type=refresh_token" });

    expect(lastGuardedOptions().mode).toBe("trusted_env_proxy");
  });

  it("keeps the strict default when no proxy is configured", async () => {
    setProxyEnv({});

    await fetchWithTimeout(TOKEN_URL, { method: "POST" });

    expect(lastGuardedOptions().mode).toBeUndefined();
  });

  it("keeps the strict default when NO_PROXY bypasses the target host", async () => {
    setProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "googleapis.com" });

    await fetchWithTimeout(TOKEN_URL, { method: "POST" });

    expect(lastGuardedOptions().mode).toBeUndefined();
  });

  it("keeps the strict default for ALL_PROXY-only environments", async () => {
    setProxyEnv({ ALL_PROXY: "http://127.0.0.1:7897" });

    await fetchWithTimeout(TOKEN_URL, { method: "POST" });

    expect(lastGuardedOptions().mode).toBeUndefined();
  });
});
