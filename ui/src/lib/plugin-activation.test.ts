// Control UI tests cover plugin activation behavior.
import { describe, expect, it } from "vitest";
import { isPluginEnabledInConfigSnapshot } from "./plugin-activation.ts";

describe("isPluginEnabledInConfigSnapshot", () => {
  it("uses the supplied default when config has not loaded yet", () => {
    expect(
      isPluginEnabledInConfigSnapshot({ hash: "hash-1" }, "memory-wiki", {
        enabledByDefault: false,
      }),
    ).toBe(false);
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

  it("treats plugins selected in plugins.slots.memory as enabled even when omitted from plugins.allow", () => {
    expect(
      isPluginEnabledInConfigSnapshot(
        {
          hash: "hash-1",
          config: {
            plugins: {
              slots: {
                memory: "custom-memory-plugin",
              },
              allow: ["browser"],
            },
          },
        },
        "custom-memory-plugin",
        { enabledByDefault: false },
      ),
    ).toBe(true);
  });

  it("respects explicit entry disabled state even if selected in plugins.slots.memory", () => {
    expect(
      isPluginEnabledInConfigSnapshot(
        {
          hash: "hash-1",
          config: {
            plugins: {
              slots: {
                memory: "custom-memory-plugin",
              },
              entries: {
                "custom-memory-plugin": {
                  enabled: false,
                },
              },
            },
          },
        },
        "custom-memory-plugin",
        { enabledByDefault: false },
      ),
    ).toBe(false);
  });

  it("treats plugins listed in plugins.allow as explicitly enabled", () => {
    expect(
      isPluginEnabledInConfigSnapshot(
        {
          hash: "hash-1",
          config: {
            plugins: {
              allow: ["my-allowed-plugin"],
            },
          },
        },
        "my-allowed-plugin",
        { enabledByDefault: false },
      ),
    ).toBe(true);
  });
});
