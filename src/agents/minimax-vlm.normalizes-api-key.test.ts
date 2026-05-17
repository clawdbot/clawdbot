import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "./minimax-vlm.js";

describe("minimaxUnderstandImage apiKey normalization", () => {
  const priorFetch = global.fetch;
  const priorMinimaxApiHost = process.env.MINIMAX_API_HOST;
  const apiResponse = JSON.stringify({
    base_resp: { status_code: 0, status_msg: "ok" },
    content: "ok",
  });

  afterEach(() => {
    global.fetch = priorFetch;
    if (priorMinimaxApiHost === undefined) {
      delete process.env.MINIMAX_API_HOST;
    } else {
      process.env.MINIMAX_API_HOST = priorMinimaxApiHost;
    }
    vi.restoreAllMocks();
  });

  async function runNormalizationCase(apiKey: string) {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth).toBe("Bearer minimax-test-key");

      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const text = await minimaxUnderstandImage({
      apiKey,
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    });

    expect(text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
  }

  it("strips embedded CR/LF before sending Authorization header", async () => {
    await runNormalizationCase("minimax-test-\r\nkey");
  });

  it("drops non-Latin1 characters from apiKey before sending Authorization header", async () => {
    await runNormalizationCase("minimax-\u0417\u2502test-key");
  });

  it("keeps trusted MINIMAX_API_HOST env fallback for VLM routing", async () => {
    process.env.MINIMAX_API_HOST = "https://api.minimaxi.com";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(requestUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
      }),
    ).resolves.toBe("ok");

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each(["minimax-cn", "minimax-portal-cn"])(
    "routes %s to the CN VLM host by default",
    async (provider) => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        expect(requestUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
        return new Response(apiResponse, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      global.fetch = withFetchPreconnect(fetchSpy);

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          provider,
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
        }),
      ).resolves.toBe("ok");

      expect(fetchSpy).toHaveBeenCalledOnce();
    },
  );

  it.each(["minimax-cn", "minimax-portal-cn"])(
    "keeps %s on the CN VLM host when the configured host is malformed",
    async (provider) => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        expect(requestUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
        return new Response(apiResponse, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      global.fetch = withFetchPreconnect(fetchSpy);

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          provider,
          apiHost: "https://[",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
        }),
      ).resolves.toBe("ok");

      expect(fetchSpy).toHaveBeenCalledOnce();
    },
  );

  it("uses the caller-provided request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn(async () => {
      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: 180_000,
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
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
