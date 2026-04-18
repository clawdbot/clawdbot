import { describe, expect, it } from "vitest";
import { __testing } from "../test-api.js";
import { createExaWebSearchProvider as createContractExaWebSearchProvider } from "../web-search-contract-api.js";
import { createExaWebSearchProvider } from "./exa-web-search-provider.js";

describe("exa web search provider", () => {
  it("exposes the expected metadata and selection wiring", () => {
    const provider = createExaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("exa");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.exa.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.exa?.enabled).toBe(true);
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createExaWebSearchProvider();
    const contractProvider = createContractExaWebSearchProvider();
    if (!contractProvider.applySelectionConfig) {
      throw new Error("Expected contract applySelectionConfig to be defined");
    }
    const applied = contractProvider.applySelectionConfig({});

    expect(contractProvider).toMatchObject({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      onboardingScopes: provider.onboardingScopes,
      credentialLabel: provider.credentialLabel,
      envVars: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
      docsUrl: provider.docsUrl,
      autoDetectOrder: provider.autoDetectOrder,
      credentialPath: provider.credentialPath,
    });
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
    expect(applied.plugins?.entries?.exa?.enabled).toBe(true);
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(__testing.resolveExaApiKey({ apiKey: "exa-secret" })).toBe("exa-secret");
  });

  it("normalizes Exa result descriptions from highlights before text", () => {
    expect(
      __testing.resolveExaDescription({
        highlights: ["first", "", "second"],
        text: "full text",
      }),
    ).toBe("first\nsecond");
    expect(__testing.resolveExaDescription({ text: "full text" })).toBe("full text");
  });

  it("handles month freshness without date overflow", () => {
    const iso = __testing.resolveFreshnessStartDate("month");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it("accepts current Exa contents object options from the docs", () => {
    expect(
      __testing.parseExaContents({
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      }),
    ).toEqual({
      value: {
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      },
    });
  });

  it("rejects invalid Exa contents objects", () => {
    expect(
      __testing.parseExaContents({
        highlights: { numSentences: 0 },
      }),
    ).toMatchObject({
      error: "invalid_contents",
    });
  });

  it("exposes newer documented Exa search types and count limits", () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const parameters = tool.parameters as {
      properties?: {
        count?: { maximum?: number };
        type?: { enum?: string[] };
      };
    };

    expect(parameters.properties?.count?.maximum).toBe(100);
    expect(parameters.properties?.type?.enum).toEqual([
      "auto",
      "neural",
      "fast",
      "deep",
      "deep-reasoning",
      "instant",
    ]);
    expect(__testing.resolveExaSearchCount(80, 10)).toBe(80);
    expect(__testing.resolveExaSearchCount(120, 10)).toBe(100);
  });

  it("returns validation errors for conflicting time filters", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      freshness: "day",
      date_after: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "conflicting_time_filters",
    });
  });

  it("returns validation errors for invalid date input", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-02-31",
    });

    expect(result).toMatchObject({
      error: "invalid_date",
    });
  });
});
