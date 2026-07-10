// Legacy web-search migration tests cover doctor repair of old web search config.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebSearchConfig,
} from "./legacy-web-search-migrate.js";

describe("legacy web search config", () => {
  it("migrates legacy provider config through bundled web search ownership metadata", () => {
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            provider: "grok",
            apiKey: "brave-key",
            grok: {
              apiKey: "xai-key",
              model: "grok-4-1-fast",
            },
            kimi: {
              apiKey: "kimi-key",
              model: "kimi-k2.5",
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      provider: "grok",
    });
    expect(res.config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-key",
          model: "grok-4.3",
        },
      },
    });
    expect(res.config.plugins?.entries?.moonshot).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "kimi-key",
          model: "kimi-k2.5",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      'Updated tools.web.search.grok.model from "grok-4-1-fast" to "grok-4.3".',
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
      "Moved tools.web.search.kimi → plugins.entries.moonshot.config.webSearch.",
    ]);
  });

  it("repairs retired Grok code aliases while preserving current aliases", () => {
    const retired = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: { grok: { model: "grok-code-fast-1" } },
        },
      },
    });
    const current = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: { grok: { model: "grok-latest" } },
        },
      },
    });

    expect(retired.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      model: "grok-build-0.1",
    });
    expect(retired.changes).toEqual([
      'Updated tools.web.search.grok.model from "grok-code-fast-1" to "grok-build-0.1".',
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
    ]);
    expect(current.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      model: "grok-latest",
    });
  });

  it("does not mutate the caller's original config", () => {
    const input = {
      tools: {
        web: {
          search: {
            provider: "grok",
            apiKey: "brave-key",
            grok: {
              apiKey: "xai-key",
              model: "grok-4-search",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const original = structuredClone(input);

    const res = migrateLegacyWebSearchConfig<OpenClawConfig>(input);

    expect(res.config.plugins?.entries?.xai?.config?.webSearch).toEqual({
      apiKey: "xai-key",
      model: "grok-4-search",
    });
    expect(input).toEqual(original);
  });

  it("preserves unrelated record-valued web search config", () => {
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            apiKey: "brave-key",
            customSearch: {
              endpoint: "https://search.example.test",
              mode: "strict",
            },
            openaiCodex: {
              enabled: true,
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      customSearch: {
        endpoint: "https://search.example.test",
        mode: "strict",
      },
      openaiCodex: {
        enabled: true,
      },
    });
    expect(res.config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
    });
  });

  it("drops dangerous record keys while preserving unrelated web search config", () => {
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            apiKey: "brave-key",
            ["__proto__"]: {
              polluted: true,
            },
            constructor: {
              polluted: true,
            },
            customSearch: {
              endpoint: "https://search.example.test",
            },
            prototype: {
              polluted: true,
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      customSearch: {
        endpoint: "https://search.example.test",
      },
    });
  });

  it("lists legacy paths for metadata-owned provider config", () => {
    expect(
      listLegacyWebSearchConfigPaths({
        tools: {
          web: {
            search: {
              apiKey: "brave-key",
              grok: {
                apiKey: "xai-key",
                model: "grok-4-search",
              },
              kimi: {
                model: "kimi-k2.5",
              },
            },
          },
        },
      }),
    ).toEqual([
      "tools.web.search.apiKey",
      "tools.web.search.grok.apiKey",
      "tools.web.search.grok.model",
      "tools.web.search.kimi.model",
    ]);
  });
});
