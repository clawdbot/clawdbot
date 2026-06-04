/**
 * Tests provider enablement config helpers exposed through the plugin SDK.
 */
import { describe, expect, it } from "vitest";
import { enablePluginInConfig as enableFetchPluginInConfig } from "./provider-web-fetch-contract.js";
import { enablePluginInConfig as enableSearchPluginInConfig } from "./provider-web-search-contract.js";

describe("provider contract enablePluginInConfig", () => {
  it("enables and allowlists provider plugins without touching channels", () => {
    const config = {
      plugins: {
        allow: ["openai"],
      },
      channels: {
        brave: { enabled: false },
      },
    };

    const result = enableSearchPluginInConfig(config, "brave");

    expect(result).toEqual({
      enabled: true,
      config: {
        plugins: {
          allow: ["openai", "brave"],
          entries: {
            brave: { enabled: true },
          },
        },
        channels: {
          brave: { enabled: false },
        },
      },
    });
  });

  it("shares denylist behavior across provider contract subpaths", () => {
    const config = {
      plugins: {
        deny: ["firecrawl"],
      },
    };

    expect(enableFetchPluginInConfig(config, "firecrawl")).toEqual({
      config,
      enabled: false,
      reason: "blocked by denylist",
    });
  });
});
