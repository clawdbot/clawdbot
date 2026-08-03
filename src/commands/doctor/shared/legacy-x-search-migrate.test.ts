// Legacy X search migration tests cover doctor repair of old X search config.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

describe("legacy x_search config migration", () => {
  it("moves only legacy x_search auth into the xai plugin config", () => {
    const res = migrateLegacyXSearchConfig({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "grok-4-1-fast",
          },
        } as Record<string, unknown>,
      },
    } as OpenClawConfig);

    expect((res.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-legacy-key",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
    ]);
  });

  it("keeps explicit plugin-owned auth when migrating legacy x_search config", () => {
    const res = migrateLegacyXSearchConfig({
      tools: {
        web: {
          x_search: {
            apiKey: "xai-legacy-key",
            enabled: true,
            model: "legacy-model",
            cacheTtlMinutes: 5,
          },
        } as Record<string, unknown>,
      },
      plugins: {
        entries: {
          xai: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "plugin-key",
              },
              xSearch: {
                model: "plugin-model",
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect((res.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "legacy-model",
      cacheTtlMinutes: 5,
    });
    expect(res.config.plugins?.entries?.xai?.config).toEqual({
      webSearch: {
        apiKey: "plugin-key",
      },
      xSearch: {
        model: "plugin-model",
      },
    });
  });

  it("moves legacy x_search SecretRefs into the xai plugin auth slot unchanged", () => {
    const res = migrateLegacyXSearchConfig({
      tools: {
        web: {
          x_search: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "X_SEARCH_KEY_REF",
            },
            enabled: true,
          },
        } as Record<string, unknown>,
      },
    } as OpenClawConfig);

    expect((res.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "X_SEARCH_KEY_REF",
          },
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.",
    ]);
  });

  it("repairs a retired knob-only x_search model without creating plugin config", () => {
    const config = {
      tools: {
        web: {
          x_search: {
            enabled: true,
            model: "grok-4-1-fast-non-reasoning",
          },
        } as Record<string, unknown>,
      },
    } as OpenClawConfig;

    const res = migrateLegacyXSearchConfig(config);

    expect((res.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4.3",
    });
    expect(res.changes).toEqual([
      'Updated tools.web.x_search.model from "grok-4-1-fast-non-reasoning" to "grok-4.3".',
    ]);
    expect(res.config.plugins?.entries?.xai).toBeUndefined();
    expect(config.tools?.web).toEqual({
      x_search: { enabled: true, model: "grok-4-1-fast-non-reasoning" },
    });
  });

  it("repairs retired Grok code aliases and preserves current aliases", () => {
    const retired = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { model: "grok-code-fast-1" } } },
    } as OpenClawConfig);
    const current = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { model: "grok-latest" } } },
    } as OpenClawConfig);

    expect((retired.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      model: "grok-build-0.1",
    });
    expect(retired.changes).toEqual([
      'Updated tools.web.x_search.model from "grok-code-fast-1" to "grok-build-0.1".',
    ]);
    expect(current).toEqual({
      config: { tools: { web: { x_search: { model: "grok-latest" } } } },
      changes: [],
    });
  });
});
