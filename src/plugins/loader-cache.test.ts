/** Tests plugin registry cache-key sensitivity to activation-relevant config. */
import { describe, expect, it } from "vitest";
import { resolvePluginRegistryLoadCacheKey } from "./loader-cache.js";

describe("resolvePluginRegistryLoadCacheKey", () => {
  it.each(["same config", "shared plugin config"] as const)(
    "separates absent, disabled, and enabled channel flags with %s",
    (mode) => {
      // channels.<id>.enabled steers activation on both sides, so each state needs its own registry.
      const plugins = {};
      const keyFor = (channel: Record<string, unknown>) => {
        const source = { plugins, channels: { telegram: channel } };
        return resolvePluginRegistryLoadCacheKey({
          config:
            mode === "same config"
              ? source
              : { plugins, channels: { telegram: { enabled: true } } },
          activationSourceConfig: source,
          env: {},
        });
      };
      const absent = keyFor({});
      const disabled = keyFor({ enabled: false });
      const enabled = keyFor({ enabled: true });

      expect(new Set([absent, disabled, enabled]).size).toBe(3);
    },
  );
});
