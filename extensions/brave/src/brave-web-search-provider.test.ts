import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "../test-api.js";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const braveManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as {
  configSchema?: Record<string, unknown>;
};

describe("brave web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("normalizes brave language parameters and swaps reversed ui/search inputs", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "en-US",
        ui_lang: "ja",
      }),
    ).toEqual({
      search_lang: "jp",
      ui_lang: "en-US",
    });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "tr-TR", ui_lang: "tr" })).toEqual(
      {
        search_lang: "tr",
        ui_lang: "tr-TR",
      },
    );
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "EN", ui_lang: "en-us" })).toEqual(
      {
        search_lang: "en",
        ui_lang: "en-US",
      },
    );
  });

  it("flags invalid brave language fields", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "xx",
      }),
    ).toEqual({ invalidField: "search_lang" });
    expect(__testing.normalizeBraveLanguageParams({ search_lang: "en-US" })).toEqual({
      invalidField: "search_lang",
    });
    expect(__testing.normalizeBraveLanguageParams({ ui_lang: "en" })).toEqual({
      invalidField: "ui_lang",
    });
  });

  it("normalizes Brave country codes and falls back unsupported values to ALL", () => {
    expect(__testing.normalizeBraveCountry("de")).toBe("DE");
    expect(__testing.normalizeBraveCountry(" VN ")).toBe("ALL");
    expect(__testing.normalizeBraveCountry("")).toBeUndefined();
  });

  it("defaults brave mode to web unless llm-context is explicitly selected", () => {
    expect(__testing.resolveBraveMode()).toBe("web");
    expect(__testing.resolveBraveMode({ mode: "llm-context" })).toBe("llm-context");
  });

  it("accepts llm-context in the Brave plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "llm-context",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid Brave mode values in the plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "invalid-mode",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "webSearch.mode",
        allowedValues: ["web", "llm-context"],
      }),
    );
  });

  it("maps llm-context results into wrapped source entries", () => {
    expect(
      __testing.mapBraveLlmContextResults({
        grounding: {
          generic: [
            {
              url: "https://example.com/post",
              title: "Example",
              snippets: ["a", "", "b"],
            },
          ],
        },
      }),
    ).toEqual([
      {
        url: "https://example.com/post",
        title: "Example",
        snippets: ["a", "b"],
        siteName: "example.com",
      },
    ]);
  });

  it("returns validation errors for invalid date ranges", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "invalid_date_range",
    });
  });

  it("falls back unsupported country values before calling Brave", async () => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({
      query: "latest Vietnam news",
      country: "VN",
    });

    const requestUrl = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("country")).toBe("ALL");
  });
});
