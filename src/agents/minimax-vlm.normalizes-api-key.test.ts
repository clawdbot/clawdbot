// Covers MiniMax VLM auth/header normalization and provider-specific routing.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "./minimax-vlm.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...mod,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

describe("minimaxUnderstandImage apiKey normalization", () => {
  const priorMinimaxApiHost = process.env.MINIMAX_API_HOST;
  const okJson = JSON.stringify({
    base_resp: { status_code: 0, status_msg: "ok" },
    content: "ok",
  });

  function guardedOk(headers?: Record<string, string>) {
    return {
      response: new Response(okJson, {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers },
      }),
      release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      finalUrl: "https://api.minimax.io/v1/coding_plan/vlm",
    };
  }

  afterEach(() => {
    if (priorMinimaxApiHost === undefined) {
      delete process.env.MINIMAX_API_HOST;
    } else {
      process.env.MINIMAX_API_HOST = priorMinimaxApiHost;
    }
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  async function runNormalizationCase(apiKey: string) {
    // Headers must be Latin-1 and line-break free; normalize user/API-key
    // input before constructing the Authorization header.
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

    const text = await minimaxUnderstandImage({
      apiKey,
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    });

    expect(text).toBe("ok");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    const auth = new Headers(opts?.init?.headers).get("Authorization");
    expect(auth).toBe("Bearer minimax-test-key");
  }

  it("strips embedded CR/LF before sending Authorization header", async () => {
    await runNormalizationCase("minimax-test-\r\nkey");
  });

  it("drops non-Latin1 characters from apiKey before sending Authorization header", async () => {
    await runNormalizationCase("minimax-З│test-key");
  });

  it("keeps trusted MINIMAX_API_HOST env fallback for VLM routing", async () => {
    process.env.MINIMAX_API_HOST = "https://api.minimaxi.com";
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
      }),
    ).resolves.toBe("ok");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(opts?.url).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it.each(["minimax-cn", "minimax-portal-cn"])(
    "routes %s to the CN VLM host by default",
    async (provider) => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          provider,
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
        }),
      ).resolves.toBe("ok");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
      expect(opts?.url).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
    },
  );

  it.each(["minimax-cn", "minimax-portal-cn"])(
    "keeps %s on the CN VLM host when the configured host is malformed",
    async (provider) => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          provider,
          apiHost: "https://[",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
        }),
      ).resolves.toBe("ok");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
      expect(opts?.url).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
    },
  );

  it("uses the caller-provided request timeout", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: 180_000,
      }),
    ).resolves.toBe("ok");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(opts?.timeoutMs).toBe(180_000);
  });

  it("uses the default request timeout for non-positive caller timeouts", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: 0,
      }),
    ).resolves.toBe("ok");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(opts?.timeoutMs).toBe(60_000);
  });

  it("clamps oversized caller request timeouts before creating the abort signal", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBe("ok");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const opts = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(opts?.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  describe("SSRF policy", () => {
    it("pins a default hostname without granting broad private-network access", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://api.minimax.io",
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeDefined();
      expect(opts?.policy.hostnameAllowlist).toEqual(["api.minimax.io"]);
      // Native public hosts stay DNS-pinned without trusting a rebinding target.
      expect(opts?.policy.allowedOrigins).toBeUndefined();
      expect(opts?.policy.allowPrivateNetwork).toBeUndefined();
      expect(opts?.policy.dangerouslyAllowPrivateNetwork).toBeUndefined();
    });

    it("pins a custom public hostname and preserves the configured origin", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://custom-minimax.example.com",
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeDefined();
      expect(opts?.policy.hostnameAllowlist).toEqual(["custom-minimax.example.com"]);
      // Custom origins are preserved as allowedOrigins so operator-configured
      // private/local MiniMax-compatible endpoints continue to work after the
      // guarded-fetch migration. Private-network flags are still absent.
      expect(opts?.policy.allowedOrigins).toEqual(["https://custom-minimax.example.com"]);
      expect(opts?.policy.allowPrivateNetwork).toBeUndefined();
      expect(opts?.policy.dangerouslyAllowPrivateNetwork).toBeUndefined();
    });

    it("preserves a loopback origin for explicitly-authorized local endpoints", async () => {
      // Loopback origins are trusted through allowedOrigins because the
      // operator explicitly configured the endpoint. This preserves existing
      // private/local MiniMax-compatible deployments.
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://localhost:8080",
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeDefined();
      expect(opts?.policy.hostnameAllowlist).toEqual(["localhost"]);
      expect(opts?.policy.allowedOrigins).toEqual(["https://localhost:8080"]);
      expect(opts?.policy.allowPrivateNetwork).toBeUndefined();
      expect(opts?.policy.dangerouslyAllowPrivateNetwork).toBeUndefined();
    });

    it("does not grant broad private-network access when allowPrivateNetwork is explicitly false", async () => {
      // Explicit denial wins over the otherwise trusted configured origin.
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://localhost:8080",
          allowPrivateNetwork: false,
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeDefined();
      expect(opts?.policy.hostnameAllowlist).toEqual(["localhost"]);
      expect(opts?.policy.allowedOrigins).toBeUndefined();
      expect(opts?.policy.allowPrivateNetwork).toBeUndefined();
      expect(opts?.policy.dangerouslyAllowPrivateNetwork).toBeUndefined();
    });

    it("keeps allowedOrigins for a custom host when allowPrivateNetwork is true", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://custom-minimax.example.com",
          allowPrivateNetwork: true,
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeDefined();
      expect(opts?.policy.hostnameAllowlist).toEqual(["custom-minimax.example.com"]);
      // Explicit allow keeps the configured origin and grants broad private-network
      // access, matching the canonical provider transport semantics.
      expect(opts?.policy.allowedOrigins).toEqual(["https://custom-minimax.example.com"]);
      expect(opts?.policy.allowPrivateNetwork).toBe(true);
      expect(opts?.policy.dangerouslyAllowPrivateNetwork).toBeUndefined();
    });

    it("keeps default-host policy unchanged when allowPrivateNetwork is false", async () => {
      // Default public hosts should never gain broad private-network trust, and
      // allowPrivateNetwork: false must not accidentally widen their policy.
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://api.minimax.io",
          allowPrivateNetwork: false,
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeDefined();
      expect(opts?.policy.hostnameAllowlist).toEqual(["api.minimax.io"]);
      expect(opts?.policy.allowedOrigins).toBeUndefined();
      expect(opts?.policy.allowPrivateNetwork).toBeUndefined();
      expect(opts?.policy.dangerouslyAllowPrivateNetwork).toBeUndefined();
    });

    it("carries model request proxy policy into the guarded fetch", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://custom-minimax.example.com",
          request: {
            proxy: { mode: "explicit-proxy", url: "https://proxy.example.com" },
          },
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.dispatcherPolicy).toEqual({
        mode: "explicit-proxy",
        proxyUrl: "https://proxy.example.com",
      });
      // Explicit proxy configuration keeps strict mode; ambient proxy auto-upgrade
      // must not replace its dispatcher policy.
      expect(opts?.mode).toBeUndefined();
    });

    it("refuses metadata-like configured origins", async () => {
      // The canonical provider policy deliberately excludes metadata- and
      // link-local-like origins from implicit trust.
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://metadata.minimax.local",
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      // No policy is produced for metadata-like origins, so guarded fetch uses
      // its default restrictions.
      expect(opts?.policy).toBeUndefined();
    });

    it("refuses link-local configured origins", async () => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce(guardedOk());

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: "https://169.254.1.1",
        }),
      ).resolves.toBe("ok");

      const opts = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
      expect(opts?.policy).toBeUndefined();
    });
  });

  it("bounds large provider error response bodies", async () => {
    // Provider error bodies can be large. Read enough for diagnostics, then
    // cancel the stream so failures stay bounded.
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${"x".repeat(9_000)}tail-marker`));
      },
      cancel() {
        canceled = true;
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Trace-Id": "trace-123" },
      }),
      release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      finalUrl: "https://api.minimax.io/v1/coding_plan/vlm",
    });

    const error = await minimaxUnderstandImage({
      apiKey: "minimax-test-key",
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    }).catch((caught: unknown) => caught);

    if (!(error instanceof Error)) {
      throw new Error("expected MiniMax VLM request to throw an Error");
    }
    expect(error.message).toContain("MiniMax VLM request failed");
    expect(error.message).toContain("Trace-Id: trace-123");
    expect(error.message).not.toContain("tail-marker");
    expect(error.message.length).toBeLessThan(520);
    expect(canceled).toBe(true);
  });

  it("bounds large successful response bodies before parsing JSON", async () => {
    let canceled = false;
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", "Trace-Id": "trace-success" },
      }),
      release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      finalUrl: "https://api.minimax.io/v1/coding_plan/vlm",
    });

    const error = await minimaxUnderstandImage({
      apiKey: "minimax-test-key",
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    }).catch((caught: unknown) => caught);

    if (!(error instanceof Error)) {
      throw new Error("expected MiniMax VLM request to reject oversized successful JSON");
    }
    expect(error.message).toBe(
      "MiniMax VLM response [Trace-Id=trace-success]: JSON response exceeds 16777216 bytes",
    );
    // WHATWG streams may pre-pull one chunk beyond the bytes consumed by the reader.
    expect(pullCount).toBeGreaterThanOrEqual(17);
    expect(pullCount).toBeLessThanOrEqual(18);
    expect(canceled).toBe(true);
  });
});

describe("isMinimaxVlmModel", () => {
  it("only matches the canonical MiniMax VLM model id", () => {
    expect(isMinimaxVlmModel("minimax", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-cn", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal-cn", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal", "custom-vision")).toBe(false);
    expect(isMinimaxVlmModel("openai", "MiniMax-VL-01")).toBe(false);
  });
});
