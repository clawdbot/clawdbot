import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";

vi.mock("../../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({
    plugins: [
      {
        id: "brave",
        origin: "bundled",
        contracts: { webSearchProviders: ["brave"] },
      },
      {
        id: "xai",
        origin: "bundled",
        contracts: { webSearchProviders: ["grok"] },
      },
      {
        id: "moonshot",
        origin: "bundled",
        contracts: { webSearchProviders: ["kimi"] },
      },
    ],
  }),
  resolveManifestContractOwnerPluginId: ({ value }: { value: string }) =>
    ({ brave: "brave", grok: "xai", kimi: "moonshot" })[value as "brave" | "grok" | "kimi"],
}));

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
              model: "grok-4-search",
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
          model: "grok-4-search",
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
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
      "Moved tools.web.search.kimi → plugins.entries.moonshot.config.webSearch.",
    ]);
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
