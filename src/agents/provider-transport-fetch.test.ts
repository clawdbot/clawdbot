import type { Model } from "@mariozechner/pi-ai";
import { Stream } from "openai/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildProviderRequestDispatcherPolicyMock,
  fetchWithSsrFGuardMock,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
  withTrustedEnvProxyGuardedFetchModeMock,
} = vi.hoisted(() => ({
  buildProviderRequestDispatcherPolicyMock: vi.fn<
    (_request?: unknown) => { mode: "direct" } | undefined
  >(() => undefined),
  fetchWithSsrFGuardMock: vi.fn(),
  mergeModelProviderRequestOverridesMock: vi.fn((current, overrides) => ({
    ...current,
    ...overrides,
  })),
  resolveProviderRequestPolicyConfigMock: vi.fn(() => ({ allowPrivateNetwork: false })),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
  withTrustedEnvProxyGuardedFetchModeMock: vi.fn((params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  })),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withTrustedEnvProxyGuardedFetchMode: withTrustedEnvProxyGuardedFetchModeMock,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: buildProviderRequestDispatcherPolicyMock,
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfig: resolveProviderRequestPolicyConfigMock,
}));

describe("buildGuardedModelFetch", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    buildProviderRequestDispatcherPolicyMock.mockClear().mockReturnValue(undefined);
    mergeModelProviderRequestOverridesMock.mockClear();
    resolveProviderRequestPolicyConfigMock
      .mockClear()
      .mockReturnValue({ allowPrivateNetwork: false });
    shouldUseEnvHttpProxyForUrlMock.mockClear().mockReturnValue(false);
    withTrustedEnvProxyGuardedFetchModeMock.mockClear();
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  it("pushes provider capture metadata into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"hello"}',
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/responses",
        capture: {
          meta: {
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.4",
          },
        },
      }),
    );
  });

  it("scopes fake-IP DNS exemptions to the configured provider host", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["api.openai.com"],
    });
    expect(policy?.allowedHostnames).toBeUndefined();
    expect(policy?.allowPrivateNetwork).toBeUndefined();
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });

  it("does not apply fake-IP exemptions to non-provider hosts", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://uploads.openai.com/v1/files", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toBeUndefined();
  });

  it("merges explicit private-network opt-in into the provider-host fake-IP policy", async () => {
    resolveProviderRequestPolicyConfigMock.mockReturnValueOnce({ allowPrivateNetwork: true });
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://10.0.0.5:11434",
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://10.0.0.5:11434/api/chat", { method: "POST" });

    const policy = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy;
    expect(policy).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: true,
      hostnameAllowlist: ["10.0.0.5"],
      allowPrivateNetwork: true,
    });
  });

  it("uses trusted env-proxy mode for provider calls when no explicit dispatcher policy is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(shouldUseEnvHttpProxyForUrlMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
    );
    expect(withTrustedEnvProxyGuardedFetchModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/responses",
        dispatcherPolicy: undefined,
        policy: {
          allowRfc2544BenchmarkRange: true,
          allowIpv6UniqueLocalRange: true,
          hostnameAllowlist: ["api.openai.com"],
        },
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/responses",
        mode: "trusted_env_proxy",
      }),
    );
  });

  it("keeps explicit provider dispatcher policies in strict guarded-fetch mode", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValueOnce(true);
    buildProviderRequestDispatcherPolicyMock.mockReturnValueOnce({ mode: "direct" });
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(withTrustedEnvProxyGuardedFetchModeMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherPolicy: { mode: "direct" },
      }),
    );
  });

  it("threads explicit transport timeouts into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const fetcher = buildGuardedModelFetch(model, 123_456);
    await fetcher("https://api.openai.com/v1/responses", { method: "POST" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 123_456,
      }),
    );
  });

  it("threads resolved provider timeout metadata into the shared guarded fetch seam", async () => {
    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "qwen3:32b",
      provider: "ollama",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      requestTimeoutMs: 300_000,
    } as unknown as Model<"ollama">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/api/chat", { method: "POST" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 300_000,
      }),
    );
  });

  it("does not force explicit debug proxy overrides onto plain HTTP model transports", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_URL = "http://127.0.0.1:7799";

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "kimi-k2.5:cloud",
      provider: "ollama",
      api: "ollama-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
    } as unknown as Model<"ollama-chat">;

    const fetcher = buildGuardedModelFetch(model);
    await fetcher("http://127.0.0.1:11434/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages":[]}',
    });

    expect(mergeModelProviderRequestOverridesMock).toHaveBeenCalledWith(undefined, {
      proxy: undefined,
    });
  });

  it("drops event-only SSE frames before the OpenAI SDK stream parser sees them", async () => {
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    const response = await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
    });
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("drops whitespace-only SSE data frames with CRLF delimiters", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: message\r\ndata:   \r\n\r\ndata: {"ok": true}\r\n\r\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://api.openai.com/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("refreshes the guarded timeout while consuming streaming response chunks", async () => {
    const encoder = new TextEncoder();
    const refreshTimeout = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
      refreshTimeout,
    });

    const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
    const model = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-completions">;

    const response = await buildGuardedModelFetch(model)(
      "https://api.openai.com/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
    expect(refreshTimeout).toHaveBeenCalledTimes(2);
  });

  describe("long retry-after handling", () => {
    const anthropicModel = {
      id: "sonnet-4.6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
    } as unknown as Model<"anthropic-messages">;

    const openaiModel = {
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as unknown as Model<"openai-responses">;

    it("injects x-should-retry:false when a retryable response exceeds the default wait cap", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("239");
      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("parses retry-after-ms from OpenAI-compatible responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after-ms": "90000" },
        }),
        finalUrl: "https://api.openai.com/v1/responses",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("parses HTTP-date retry-after values", async () => {
      const future = new Date(Date.now() + 120_000).toUTCString();
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 503,
          headers: { "retry-after": future },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("respects OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "10";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("injects x-should-retry:false for terminal 429 responses without retry-after", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response("Sorry, you've exceeded your weekly rate limit.", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        finalUrl: "https://api.individual.githubcopilot.com/responses",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(openaiModel)(
        "https://api.individual.githubcopilot.com/responses",
        { method: "POST" },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      await expect(response.text()).resolves.toContain("weekly rate limit");
    });

    it("keeps short retry-after 429 responses retryable", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("can be disabled with OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=0", async () => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "0";
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("leaves short retry-after values untouched", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });

    it("treats malformed 429 retry-after values as terminal", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": "soon" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBe("false");
    });

    it("ignores retry-after on non-retryable responses", async () => {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(null, {
          status: 400,
          headers: { "retry-after": "239" },
        }),
        finalUrl: "https://api.anthropic.com/v1/messages",
        release: vi.fn(async () => undefined),
      });

      const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
      const response = await buildGuardedModelFetch(anthropicModel)(
        "https://api.anthropic.com/v1/messages",
        { method: "POST" },
      );

      expect(response.headers.get("x-should-retry")).toBeNull();
    });
  });
});
