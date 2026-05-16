import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_COUNT,
  buildUnsupportedSearchFilterResponse,
  isoToPerplexityDate,
  normalizeToIsoDate,
  normalizeFreshness,
} from "./web-search-provider-common.js";
import { mergeScopedSearchConfig } from "./web-search-provider-config.js";
import { createWebSearchTool } from "./web-search.js";

describe("web_search tool schema", () => {
  it("marks query as required for model tool-call schemas", () => {
    const tool = createWebSearchTool();
    const parameters = tool?.parameters as { required?: unknown } | undefined;

    expect(parameters?.required).toEqual(["query"]);
  });

  it("advertises the shared runtime count limit", () => {
    const tool = createWebSearchTool();
    const parameters = tool?.parameters as
      | { properties?: { count?: { maximum?: unknown } } }
      | undefined;

    expect(parameters?.properties?.count?.maximum).toBe(MAX_SEARCH_COUNT);
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values and maps for Perplexity", () => {
    expect(normalizeFreshness("pd", "brave")).toBe("pd");
    expect(normalizeFreshness("PW", "brave")).toBe("pw");
    expect(normalizeFreshness("pd", "perplexity")).toBe("day");
    expect(normalizeFreshness("pw", "perplexity")).toBe("week");
  });

  it("accepts Perplexity values and maps for Brave", () => {
    expect(normalizeFreshness("day", "perplexity")).toBe("day");
    expect(normalizeFreshness("week", "perplexity")).toBe("week");
    expect(normalizeFreshness("day", "brave")).toBe("pd");
    expect(normalizeFreshness("week", "brave")).toBe("pw");
  });

  it("accepts valid date ranges for Brave", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31", "brave")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid values", () => {
    expect(normalizeFreshness("yesterday", "brave")).toBeUndefined();
    expect(normalizeFreshness("yesterday", "perplexity")).toBeUndefined();
    expect(normalizeFreshness("2024-01-01to2024-01-31", "perplexity")).toBeUndefined();
  });

  it("rejects invalid date ranges for Brave", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01", "brave")).toBeUndefined();
  });
});

describe("web_search date normalization", () => {
  it("accepts ISO format", () => {
    expect(normalizeToIsoDate("2024-01-15")).toBe("2024-01-15");
    expect(normalizeToIsoDate("2025-12-31")).toBe("2025-12-31");
  });

  it("accepts Perplexity format and converts to ISO", () => {
    expect(normalizeToIsoDate("1/15/2024")).toBe("2024-01-15");
    expect(normalizeToIsoDate("12/31/2025")).toBe("2025-12-31");
  });

  it("rejects invalid formats", () => {
    expect(normalizeToIsoDate("01-15-2024")).toBeUndefined();
    expect(normalizeToIsoDate("2024/01/15")).toBeUndefined();
    expect(normalizeToIsoDate("invalid")).toBeUndefined();
  });

  it("converts ISO to Perplexity format", () => {
    expect(isoToPerplexityDate("2024-01-15")).toBe("1/15/2024");
    expect(isoToPerplexityDate("2025-12-31")).toBe("12/31/2025");
    expect(isoToPerplexityDate("2024-03-05")).toBe("3/5/2024");
  });

  it("rejects invalid ISO dates", () => {
    expect(isoToPerplexityDate("1/15/2024")).toBeUndefined();
    expect(isoToPerplexityDate("invalid")).toBeUndefined();
  });
});

describe("web_search unsupported filter response", () => {
  it("returns undefined when no unsupported filter is set", () => {
    expect(buildUnsupportedSearchFilterResponse({ query: "openclaw" }, "gemini")).toBeUndefined();
  });

  it("maps non-date filters to provider-specific unsupported errors", () => {
    expect(buildUnsupportedSearchFilterResponse({ country: "us" }, "grok")).toEqual({
      error: "unsupported_country",
      message:
        "country filtering is not supported by the grok provider. Only Brave and Perplexity support country filtering.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("collapses date filters to unsupported_date_filter", () => {
    expect(buildUnsupportedSearchFilterResponse({ date_before: "2026-03-19" }, "kimi")).toEqual({
      error: "unsupported_date_filter",
      message:
        "date_after/date_before filtering is not supported by the kimi provider. Only Brave and Perplexity support date filtering.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });
});

describe("web_search scoped config merge", () => {
  it("returns the original config when no plugin config exists", () => {
    const searchConfig = { provider: "grok", grok: { model: "grok-4-1-fast" } };
    expect(mergeScopedSearchConfig(searchConfig, "grok", undefined)).toBe(searchConfig);
  });

  it("merges plugin config into the scoped provider object", () => {
    expect(
      mergeScopedSearchConfig({ provider: "grok", grok: { model: "old-model" } }, "grok", {
        model: "new-model",
        apiKey: "xai-test-key",
      }),
    ).toEqual({
      provider: "grok",
      grok: { model: "new-model", apiKey: "xai-test-key" },
    });
  });

  it("can mirror the plugin apiKey to the top level config", () => {
    expect(
      mergeScopedSearchConfig(
        { provider: "brave", brave: { count: 5 } },
        "brave",
        { apiKey: "brave-test-key" },
        { mirrorApiKeyToTopLevel: true },
      ),
    ).toEqual({
      provider: "brave",
      apiKey: "brave-test-key",
      brave: { count: 5, apiKey: "brave-test-key" },
    });
  });
});
