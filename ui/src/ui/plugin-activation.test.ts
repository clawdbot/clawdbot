import { describe, expect, it } from "vitest";
import { isPluginEnabledInConfigSnapshot } from "./plugin-activation.ts";

describe("isPluginEnabledInConfigSnapshot", () => {
  it("stays permissive when config has not loaded yet", () => {
    expect(
      isPluginEnabledInConfigSnapshot({ hash: "hash-1" }, "memory-wiki", {
        enabledByDefault: false,
      }),
    ).toBe(true);
  });

  it("treats bundled default-off plugins as disabled when config is present but silent", () => {
    expect(
      isPluginEnabledInConfigSnapshot(
        {
          hash: "hash-1",
          config: {
            plugins: {},
          },
        },
        "memory-wiki",
        {
          enabledByDefault: false,
        },
      ),
    ).toBe(false);
  });

  it("returns true when the plugin is explicitly enabled", () => {
    expect(
      isPluginEnabledInConfigSnapshot(
        {
          hash: "hash-1",
          config: {
            plugins: {
              entries: {
                "memory-wiki": {
                  enabled: true,
                },
              },
            },
          },
        },
        "memory-wiki",
        { enabledByDefault: false },
      ),
    ).toBe(true);
  });

  it("returns false when plugins.allow excludes the plugin", () => {
    expect(
      isPluginEnabledInConfigSnapshot(
        {
          hash: "hash-1",
          config: {
            plugins: {
              allow: ["memory-core"],
              entries: {
                "memory-wiki": {
                  enabled: true,
                },
              },
            },
          },
        },
        "memory-wiki",
        { enabledByDefault: false },
      ),
    ).toBe(false);
  });

  it("keeps default-on plugins enabled when config is silent", () => {
    expect(
      isPluginEnabledInConfigSnapshot({ hash: "hash-1" }, "browser", {
        enabledByDefault: true,
      }),
    ).toBe(true);
  });
});
