import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, hasEnvHttpProxyConfiguredMock, matchesNoProxyMock } = vi.hoisted(
  () => ({
    fetchWithSsrFGuardMock: vi.fn(),
    hasEnvHttpProxyConfiguredMock: vi.fn(() => false),
    matchesNoProxyMock: vi.fn(() => false),
  }),
);

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../infra/net/proxy-env.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/proxy-env.js")>(
    "../infra/net/proxy-env.js",
  );
  return {
    ...actual,
    hasEnvHttpProxyConfigured: hasEnvHttpProxyConfiguredMock,
    matchesNoProxy: matchesNoProxyMock,
  };
});

import {
  createProviderOperationDeadline,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  postTranscriptionRequest,
  readErrorResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
} from "./shared.js";

beforeEach(() => {
  hasEnvHttpProxyConfiguredMock.mockReturnValue(false);
  matchesNoProxyMock.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("provider operation deadlines", () => {
  it("keeps default per-call timeouts when no operation timeout is configured", () => {
    const deadline = createProviderOperationDeadline({
      label: "video generation",
    });

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(60_000);
  });

  it("clamps per-call timeouts to the remaining operation deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 5_000,
    });

    vi.setSystemTime(4_250);

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(1_750);
  });

  it("throws once the operation deadline has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 2_000,
    });

    vi.setSystemTime(3_001);

    expect(() => resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toThrow(
      "video generation timed out after 2000ms",
    );
  });

  it("clamps poll waits to the remaining operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 1_000,
    });
    const wait = waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeUndefined();
  });
});

describe("resolveProviderHttpRequestConfig", () => {
  it("preserves explicit caller headers but protects attribution headers", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://api.openai.com/v1",
      headers: {
        authorization: "Bearer override",
        "User-Agent": "custom-agent/1.0",
        originator: "spoofed",
      },
      defaultHeaders: {
        authorization: "Bearer default-token",
        "X-Default": "1",
      },
      provider: "openai",
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toMatch(/^openclaw\//);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBeTruthy();
  });

  it("uses the fallback base URL without enabling private-network access", () => {
    const resolved = resolveProviderHttpRequestConfig({
      defaultBaseUrl: "https://api.deepgram.com/v1/",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.deepgram.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Token test-key");
  });

  it("allows callers to preserve custom-base detection before URL normalization", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
      defaultHeaders: {
        "x-goog-api-key": "test-key",
      },
      provider: "google",
      api: "google-generative-ai",
      capability: "image",
      transport: "http",
    });

    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("surfaces dispatcher policy for explicit proxy and mTLS transport overrides", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.deepgram.com/v1",
      defaultBaseUrl: "https://api.deepgram.com/v1",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      request: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
          tls: {
            ca: "proxy-ca",
          },
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
        },
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      proxyTls: {
        ca: "proxy-ca",
      },
    });
  });

  it("fails fast when no base URL can be resolved", () => {
    expect(() =>
      resolveProviderHttpRequestConfig({
        baseUrl: "   ",
        defaultBaseUrl: "   ",
      }),
    ).toThrow("Missing baseUrl");
  });
});

describe("readErrorResponse", () => {
  it("caps streamed error bodies instead of buffering the whole response", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(encoder.encode("a".repeat(2048)));
          if (reads >= 10) {
            controller.close();
          }
        },
      }),
      {
        status: 500,
      },
    );

    const detail = await readErrorResponse(response);

    expect(detail).toBe(`${"a".repeat(300)}…`);
    expect(reads).toBe(2);
  });
});

describe("fetchWithTimeoutGuarded", () => {
  it("applies a default timeout when callers omit one", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetch);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        timeoutMs: 60_000,
      }),
    );
  });

  it("sanitizes auditContext before passing it to the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, 5000, fetch, {
      auditContext: "provider-http\r\nfal\timage\u001btest",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "provider-http fal image test",
        timeoutMs: 5000,
      }),
    );
  });

  it("passes configured explicit proxy policy through the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.deepgram.com/v1/listen",
      headers: new Headers({ authorization: "Token test-key" }),
      body: { hello: "world" },
      fetchFn: fetch,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://169.254.169.254:8080",
      },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://169.254.169.254:8080",
        },
      }),
    );
  });

  it("forwards explicit pinDns overrides to JSON requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/test",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
      pinDns: false,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });

  it("forwards explicit pinDns overrides to transcription requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.example.com/v1/transcriptions",
      headers: new Headers(),
      body: "audio-bytes",
      fetchFn: fetch,
      pinDns: false,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });

  it("does not set a guarded fetch mode when no HTTP proxy env is configured", async () => {
    hasEnvHttpProxyConfiguredMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetch);

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("mode");
  });

  it("auto-selects trusted env proxy mode when HTTP proxy env is configured", async () => {
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.minimax.io",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.minimax.io/v1/image_generation",
      headers: new Headers({ authorization: "Bearer test" }),
      body: { model: "image-01", prompt: "a red cube" },
      fetchFn: fetch,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
      }),
    );
  });

  it("respects an explicit mode from the caller when HTTP proxy env is configured", async () => {
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://api.example.com", {}, undefined, fetch, {
      mode: "strict",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "strict",
      }),
    );
  });

  it("auto-upgrades transcription requests to trusted env proxy when proxy env is configured", async () => {
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.openai.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.openai.com/v1/audio/transcriptions",
      headers: new Headers({ authorization: "Bearer test" }),
      body: "audio-bytes",
      fetchFn: fetch,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
      }),
    );
  });

  it("forwards an explicit mode override through postJsonRequest even when proxy env is configured", async () => {
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/strict",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
      mode: "strict",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "strict",
      }),
    );
  });

  it("forwards an explicit mode override through postTranscriptionRequest even when proxy env is configured", async () => {
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.example.com/v1/transcriptions",
      headers: new Headers(),
      body: "audio-bytes",
      fetchFn: fetch,
      mode: "strict",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "strict",
      }),
    );
  });

  it("does not auto-upgrade when only ALL_PROXY is configured (HTTP(S) proxy gate)", async () => {
    // ALL_PROXY is ignored by EnvHttpProxyAgent; `hasEnvHttpProxyConfigured`
    // reflects that by returning false when only ALL_PROXY is set. Auto-upgrade
    // must NOT fire, otherwise the request would skip pinned-DNS/SSRF checks
    // and then be dispatched directly.
    hasEnvHttpProxyConfiguredMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/image",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
    });

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("mode");
  });

  it("does not auto-upgrade when caller passes explicit dispatcherPolicy", async () => {
    // Callers with custom proxy URL / proxyTls / connect options must keep
    // control over the dispatcher. Auto-upgrade would build an
    // EnvHttpProxyAgent that silently drops those overrides.
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    const explicitPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://corp-proxy.internal:3128",
    };

    await fetchWithTimeoutGuarded("https://api.example.com/v1/image", {}, undefined, fetch, {
      dispatcherPolicy: explicitPolicy,
    });

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("mode");
    expect(call).toHaveProperty("dispatcherPolicy", explicitPolicy);
  });

  it("does not auto-upgrade when target URL matches NO_PROXY", async () => {
    // With HTTP_PROXY + NO_PROXY, EnvHttpProxyAgent makes direct connections
    // for NO_PROXY matches, but in TRUSTED_ENV_PROXY mode fetchWithSsrFGuard
    // skips pinned-DNS checks — so auto-upgrading those targets would bypass
    // SSRF protection. Keep strict mode for NO_PROXY matches.
    hasEnvHttpProxyConfiguredMock.mockReturnValue(true);
    matchesNoProxyMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://internal.corp.example",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://internal.corp.example/v1/image",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
    });

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("mode");
  });
});
