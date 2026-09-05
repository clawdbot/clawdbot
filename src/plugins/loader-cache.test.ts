/** Tests plugin registry cache-key sensitivity to activation-relevant config. */
import { describe, expect, it } from "vitest";
import { resolvePluginRegistryLoadCacheKey } from "./loader-cache.js";

describe("resolvePluginRegistryLoadCacheKey", () => {
  it("separates absent, disabled, and enabled channel flags", () => {
    // channels.<id>.enabled steers activation on both sides, so each state needs its own registry.
    const keyFor = (channel: Record<string, unknown>) =>
      resolvePluginRegistryLoadCacheKey({
        config: { channels: { telegram: channel } },
        env: {},
      });
    const absent = keyFor({});
    const disabled = keyFor({ enabled: false });
    const enabled = keyFor({ enabled: true });

    expect(new Set([absent, disabled, enabled]).size).toBe(3);
  });
});
