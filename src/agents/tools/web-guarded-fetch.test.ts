import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import {
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

vi.mock("../../infra/net/fetch-guard.js", () => {
  const GUARDED_FETCH_MODE = {
    STRICT: "strict",
    TRUSTED_ENV_PROXY: "trusted_env_proxy",
  } as const;
  return {
    GUARDED_FETCH_MODE,
    fetchWithSsrFGuard: vi.fn(),
    withStrictGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: GUARDED_FETCH_MODE.STRICT,
    }),
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
    }),
  };
});

function firstFetchCall(): Record<string, unknown> {
  const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("Expected guarded fetch call");
  }
  return call as Record<string, unknown>;
}

describe("web-guarded-fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses a host-scoped fake-IP SSRF policy for trusted web tools endpoints", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    const call = firstFetchCall();
    expect(call?.url).toBe("https://example.com");
    expect(call?.policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["example.com"],
    });
    expect(call?.mode).toBe(GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY);
  });

  it("uses private-network policy only for self-hosted web tools endpoints", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "http://127.0.0.1:8080",
      release: async () => {},
    });

    await withSelfHostedWebToolsEndpoint({ url: "http://127.0.0.1:8080" }, async () => undefined);

    const call = firstFetchCall();
    expect(call?.url).toBe("http://127.0.0.1:8080");
    const policy = call.policy as Record<string, unknown> | undefined;
    expect(policy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(policy?.allowRfc2544BenchmarkRange).toBe(true);
    expect(policy?.allowIpv6UniqueLocalRange).toBe(true);
    expect(call?.mode).toBe(GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY);
  });

  it("keeps strict endpoint policy unchanged", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    const call = firstFetchCall();
    expect(call?.url).toBe("https://example.com");
    expect(call?.policy).toBeUndefined();
    expect(call?.mode).toBe(GUARDED_FETCH_MODE.STRICT);
  });

  it("normalizes string timeouts before guarded fetch dispatch", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint(
      { url: "https://example.com", timeoutSeconds: "7" as never },
      async () => undefined,
    );
    expect(firstFetchCall().timeoutMs).toBe(7000);

    vi.clearAllMocks();
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint(
      {
        url: "https://example.com",
        timeoutMs: "2500" as never,
        timeoutSeconds: "7" as never,
      },
      async () => undefined,
    );
    expect(firstFetchCall().timeoutMs).toBe(2500);
  });

  it("caps oversized timeoutSeconds before guarded fetch dispatch", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint(
      { url: "https://example.com", timeoutSeconds: Number.MAX_SAFE_INTEGER },
      async () => undefined,
    );

    expect(firstFetchCall().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("rejects malformed timeouts before guarded fetch dispatch", async () => {
    await expect(
      withStrictWebToolsEndpoint(
        { url: "https://example.com", timeoutMs: "2.5" as never },
        async () => undefined,
      ),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(
      withStrictWebToolsEndpoint(
        { url: "https://example.com", timeoutSeconds: -1 },
        async () => undefined,
      ),
    ).rejects.toThrow("timeoutSeconds must be a positive integer");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
