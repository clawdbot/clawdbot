// Covers plugin web-search config parsing and defaults.
import { describe, expect, it } from "vitest";
import { resolvePluginWebSearchConfig } from "./plugin-web-search-config.js";

describe("resolvePluginWebSearchConfig", () => {
  it("returns the nested plugin webSearch object when present", () => {
    expect(
      resolvePluginWebSearchConfig(
        {
          plugins: {
            entries: {
              brave: {
                config: {
                  webSearch: {
                    apiKey: "brave-key",
                  },
                },
              },
            },
          },
        },
        "brave",
      ),
    ).toEqual({
      apiKey: "brave-key",
    });
  });

  it("ignores non-record plugin config values", () => {
    expect(
      resolvePluginWebSearchConfig(
        {
          plugins: {
            entries: {
              brave: {
                config: "nope",
              },
            },
          },
        },
        "brave",
      ),
    ).toBeUndefined();
  });
});
