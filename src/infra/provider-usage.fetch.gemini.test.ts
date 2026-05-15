import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchGeminiUsage } from "./provider-usage.fetch.gemini.js";

const usageProvider = "openai-codex" as const;

describe("fetchGeminiUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "rate_limited" }),
    );
    const result = await fetchGeminiUsage("token", 5000, mockFetch, usageProvider);

    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("returns a stable error for malformed successful usage JSON", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, "{not json"));
    const result = await fetchGeminiUsage("token", 5000, mockFetch, usageProvider);

    expect(result.error).toBe("Malformed usage response");
    expect(result.windows).toHaveLength(0);
  });

  it("selects the lowest remaining fraction per model family", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("Bearer token");

      return makeResponse(200, {
        buckets: [
          { modelId: "gemini-pro", remainingFraction: 0.8 },
          { modelId: "gemini-pro-preview", remainingFraction: 0.3 },
          { modelId: "gemini-flash", remainingFraction: 0.7 },
          { modelId: "gemini-flash-latest", remainingFraction: 0.9 },
          { modelId: "gemini-unknown", remainingFraction: 0.5 },
        ],
      });
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, usageProvider);

    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toEqual({ label: "Pro", usedPercent: 70 });
    expect(result.windows[1]?.label).toBe("Flash");
    expect(result.windows[1]?.usedPercent).toBeCloseTo(30, 6);
  });

  it("returns no windows when the response has no recognized model families", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        buckets: [{ modelId: "gemini-unknown", remainingFraction: 0.5 }],
      }),
    );

    const result = await fetchGeminiUsage("token", 5000, mockFetch, usageProvider);

    expect(result).toEqual({
      provider: usageProvider,
      displayName: "Codex",
      windows: [],
    });
  });

  it("defaults missing fractions to fully available and clamps invalid fractions", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        buckets: [
          { modelId: "gemini-pro" },
          { modelId: "gemini-pro-latest", remainingFraction: -0.5 },
          { modelId: "gemini-flash", remainingFraction: 1.2 },
        ],
      }),
    );

    const result = await fetchGeminiUsage("token", 5000, mockFetch, usageProvider);

    expect(result.windows).toEqual([
      { label: "Pro", usedPercent: 100 },
      { label: "Flash", usedPercent: 0 },
    ]);
  });
});
