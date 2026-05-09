import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyXSearchConfigPaths,
  migrateLegacyXSearchConfig,
} from "./legacy-x-search-migrate.js";

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

  it("does nothing for knob-only x_search config without a legacy apiKey", () => {
    const config = {
      tools: {
        web: {
          x_search: {
            enabled: true,
            model: "grok-4-1-fast",
          },
        } as Record<string, unknown>,
      },
    } as OpenClawConfig;

    const res = migrateLegacyXSearchConfig(config);

    expect(res.config).toEqual(config);
    expect(res.changes).toStrictEqual([]);
    expect(res.config.plugins?.entries?.xai).toBeUndefined();
  });

  it("lists legacy x_search paths", () => {
    expect(
      listLegacyXSearchConfigPaths({
        tools: {
          web: {
            x_search: {
              apiKey: "xai-legacy-key",
              enabled: false,
            },
          } as Record<string, unknown>,
        },
      } as OpenClawConfig),
    ).toEqual(["tools.web.x_search.apiKey"]);
  });
});
