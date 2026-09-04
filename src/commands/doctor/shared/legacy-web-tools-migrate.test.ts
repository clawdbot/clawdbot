// Legacy web tool migration tests cover provider-owned search and fetch config repair.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebFetchConfig,
  migrateLegacyWebSearchConfig,
  migrateLegacyXSearchConfig,
} from "./legacy-web-tools-migrate.js";

type LegacyWebSearchConfig = Omit<OpenClawConfig, "tools"> & {
  tools?: { web?: { search?: Record<string, unknown> } };
};

describe("legacy web search config", () => {
  it("migrates provider config in deterministic owner order", () => {
    const result = migrateLegacyWebSearchConfig<LegacyWebSearchConfig>({
      tools: {
        web: {
          search: {
            provider: "grok",
            apiKey: "test-key",
            grok: { apiKey: "test-secret", model: "grok-4-1-fast" },
            kimi: { apiKey: "sample", model: "kimi-k2.5" },
          },
        },
      },
    });

    expect(result.config.tools?.web?.search).toEqual({ provider: "grok" });
    expect(result.config.plugins?.entries?.brave?.config?.webSearch).toEqual({
      apiKey: "test-key",
    });
    expect(result.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      apiKey: "test-secret",
      model: "grok-4.3",
    });
    expect(result.config.plugins?.entries?.moonshot?.config?.webSearch).toEqual({
      apiKey: "sample",
      model: "kimi-k2.5",
    });
    expect(result.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      'Updated tools.web.search.grok.model from "grok-4-1-fast" to "grok-4.3".',
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
      "Moved tools.web.search.kimi → plugins.entries.moonshot.config.webSearch.",
    ]);
  });

  it("repairs retired Grok code aliases while preserving current aliases", () => {
    const retired = migrateLegacyWebSearchConfig<LegacyWebSearchConfig>({
      tools: { web: { search: { grok: { model: "grok-code-fast-1" } } } },
    });
    const current = migrateLegacyWebSearchConfig<LegacyWebSearchConfig>({
      tools: { web: { search: { grok: { model: "grok-latest" } } } },
    });

    expect(retired.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      model: "grok-build-0.1",
    });
    expect(retired.changes[0]).toContain("grok-build-0.1");
    expect(current.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      model: "grok-latest",
    });
  });

  it("gives global auth precedence over Brave source while recursively preserving plugin config", () => {
    const result = migrateLegacyWebSearchConfig<LegacyWebSearchConfig>({
      tools: {
        web: {
          search: {
            apiKey: "example",
            brave: {
              apiKey: "test-key",
              nested: { fromLegacy: true, shared: "legacy" },
            },
          },
        },
      },
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: { webSearch: { nested: { shared: "plugin" } } },
          },
        },
      },
    });

    expect(result.config.plugins?.entries?.brave?.config?.webSearch).toEqual({
      apiKey: "example",
      nested: { fromLegacy: true, shared: "plugin" },
    });
    expect(result.changes).toEqual([
      "Merged tools.web.search.apiKey → plugins.entries.brave.config.webSearch (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("strips empty mapped records without mutating the input or inventing a change", () => {
    const input = { tools: { web: { search: { provider: "grok", grok: {} } } } };
    const result = migrateLegacyWebSearchConfig(input);

    expect(result.config).not.toBe(input);
    expect(result.config.tools.web.search).toEqual({ provider: "grok" });
    expect(result.config).not.toHaveProperty("plugins");
    expect(result.changes).toStrictEqual([]);
    expect(input.tools.web.search).toEqual({ provider: "grok", grok: {} });
  });

  it("preserves unknown fields, drops dangerous keys, and lists mapped paths", () => {
    const input = {
      tools: {
        web: {
          search: {
            apiKey: "test-key",
            grok: { apiKey: "test-secret", model: "grok-latest" },
            customSearch: { endpoint: "https://search.example.test" },
            ["__proto__"]: { polluted: true },
            constructor: { polluted: true },
            prototype: { polluted: true },
          },
        },
      },
    };

    expect(listLegacyWebSearchConfigPaths(input)).toEqual([
      "tools.web.search.apiKey",
      "tools.web.search.grok.apiKey",
      "tools.web.search.grok.model",
    ]);
    expect(migrateLegacyWebSearchConfig(input).config.tools.web.search).toEqual({
      customSearch: { endpoint: "https://search.example.test" },
    });
  });
});

describe("legacy web fetch config", () => {
  it("moves Firecrawl config, discards enabled, and preserves other fetch knobs", () => {
    const result = migrateLegacyWebFetchConfig({
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
            timeoutSeconds: 15,
            firecrawl: {
              enabled: false,
              apiKey: "dummy",
              onlyMainContent: false,
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(result.config.tools?.web?.fetch).toEqual({
      provider: "firecrawl",
      timeoutSeconds: 15,
    });
    expect(result.config.plugins?.entries?.firecrawl).toEqual({
      enabled: true,
      config: { webFetch: { apiKey: "dummy", onlyMainContent: false } },
    });
    expect(result.changes).toEqual([
      "Moved tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch.",
    ]);
  });

  it.each([{ firecrawl: {} }, { firecrawl: { enabled: false }, timeoutSeconds: 10 }])(
    "removes an empty Firecrawl payload without creating plugin config: %j",
    (fetch) => {
      const result = migrateLegacyWebFetchConfig({ tools: { web: { fetch } } });

      expect(result.config.tools.web.fetch).toEqual(
        "timeoutSeconds" in fetch ? { timeoutSeconds: 10 } : {},
      );
      expect(result.config).not.toHaveProperty("plugins");
      expect(result.changes).toEqual(["Removed empty tools.web.fetch.firecrawl."]);
    },
  );
});

describe("legacy x_search config", () => {
  it("moves only auth and leaves the other legacy knobs in place", () => {
    const result = migrateLegacyXSearchConfig({
      tools: {
        web: {
          x_search: { apiKey: "fake", enabled: true, model: "grok-4-1-fast" },
        } as Record<string, unknown>,
      },
    } as OpenClawConfig);

    const web = result.config.tools?.web as Record<string, unknown> | undefined;
    expect(web?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(result.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      apiKey: "fake",
    });
  });

  it.each([
    { name: "value", webSearch: { apiKey: "test-token" } },
    { name: "own undefined", webSearch: { apiKey: undefined } },
  ])("keeps explicit plugin-owned auth including $name", ({ webSearch }) => {
    const result = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { apiKey: "placeholder", cacheTtlMinutes: 5 } } },
      plugins: { entries: { xai: { enabled: true, config: { webSearch } } } },
    });

    expect(result.config.plugins.entries.xai.config.webSearch).toEqual(webSearch);
    expect(result.config.tools.web.x_search).toEqual({ cacheTtlMinutes: 5 });
    expect(result.changes).toEqual([
      "Removed tools.web.x_search.apiKey (plugins.entries.xai.config.webSearch.apiKey already set).",
    ]);
  });

  it("moves SecretRefs unchanged", () => {
    const apiKey = { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" };
    const result = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { apiKey, enabled: true } } },
    } as OpenClawConfig);

    expect(result.config.plugins?.entries?.xai?.config?.webSearch).toEqual({ apiKey });
  });

  it("repairs model before auth and removes an emptied source after activating the plugin", () => {
    const combined = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { apiKey: "placeholder", model: "grok-3" } } },
    });
    const authOnly = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { apiKey: "placeholder" } } },
    });

    expect(combined.config.tools.web.x_search).toEqual({ model: "grok-4.3" });
    expect(combined.changes).toEqual([
      'Updated tools.web.x_search.model from "grok-3" to "grok-4.3".',
      "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
    ]);
    expect(authOnly.config.tools.web).not.toHaveProperty("x_search");
    expect(authOnly.changes).toEqual([
      "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
      "Removed empty tools.web.x_search.",
    ]);
  });

  it("repairs retired model-only aliases without creating plugin config", () => {
    const retired = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { enabled: true, model: "grok-code-fast-1" } } },
    });
    const current = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { model: "grok-latest" } } },
    });

    expect(retired.config.tools.web.x_search).toEqual({
      enabled: true,
      model: "grok-build-0.1",
    });
    expect(retired.config).not.toHaveProperty("plugins");
    expect(current.changes).toStrictEqual([]);
  });
});
