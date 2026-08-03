import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";
import { createEmbeddings } from "./embeddings.js";

const { fetchWithSsrFGuard } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  fetchWithSsrFGuard.mockImplementation(original.fetchWithSsrFGuard);
  return { ...original, fetchWithSsrFGuard };
});

const api = { config: {}, runtime: {} } as unknown as OpenClawPluginApi;

describe("memory-lancedb embedding transport", () => {
  beforeEach(() => {
    fetchWithSsrFGuard.mockClear();
    vi.stubEnv("http_proxy", "http://proxy.example:8080");
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("NO_PROXY", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(["http://10.0.0.1/v1", "http://169.254.169.254/v1", "http://[fe80::1]/v1"])(
    "blocks private or link-local embedding endpoint %s",
    async (baseUrl) => {
      const embeddings = createEmbeddings(api, {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          model: "text-embedding-3-small",
          baseUrl,
        },
      } as MemoryConfig);

      await expect(embeddings.embed("sensitive memory")).rejects.toMatchObject({
        name: "SsrFBlockedError",
      });
      expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "trusted_env_proxy" }),
      );
    },
  );

  it("keeps timeout-less requests bounded and retries transient failures", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard
      .mockRejectedValueOnce(Object.assign(new Error("temporary failure"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          headers: { "content-type": "application/json" },
        }),
        finalUrl: "https://embeddings.example/v1/embeddings",
        release,
      });

    try {
      const embeddings = createEmbeddings(api, {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          model: "text-embedding-3-small",
          baseUrl: "https://embeddings.example/v1",
        },
      } as MemoryConfig);
      const resultPromise = embeddings.embed("retry me");
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toEqual([0.1, 0.2]);
      expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
      for (const [request] of fetchWithSsrFGuard.mock.calls) {
        expect(request).toMatchObject({ timeoutMs: 600_000 });
      }
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry requests with a caller-owned timeout", async () => {
    fetchWithSsrFGuard.mockRejectedValueOnce(
      Object.assign(new Error("temporary failure"), { status: 500 }),
    );
    const embeddings = createEmbeddings(api, {
      embedding: {
        provider: "openai",
        apiKey: "test-key",
        model: "text-embedding-3-small",
        baseUrl: "https://embeddings.example/v1",
      },
    } as MemoryConfig);

    await expect(embeddings.embed("do not retry", { timeoutMs: 1234 })).rejects.toThrow(
      "temporary failure",
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1234 }));
  });
});
