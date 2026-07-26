import { describe, expect, it } from "vitest";
import { createLinuxNodePluginConfigSchema, resolveLinuxNodePluginConfig } from "./config.js";

describe("linux-node config", () => {
  it("uses surprise-safe capability defaults", () => {
    expect(resolveLinuxNodePluginConfig(undefined)).toEqual({
      notify: { enabled: true },
      camera: { enabled: false },
      location: { enabled: false },
    });
  });

  it("accepts explicit capability gates and rejects unknown keys", () => {
    expect(
      resolveLinuxNodePluginConfig({
        notify: { enabled: false },
        camera: { enabled: true },
        location: { enabled: true },
      }),
    ).toEqual({
      notify: { enabled: false },
      camera: { enabled: true },
      location: { enabled: true },
    });
    expect(() => resolveLinuxNodePluginConfig({ camera: { enabled: true, extra: true } })).toThrow(
      "Invalid linux-node plugin config",
    );
  });

  it("exports the same strict shape through the plugin schema", () => {
    const safeParse = createLinuxNodePluginConfigSchema().safeParse;
    if (!safeParse) {
      throw new Error("missing config schema validator");
    }
    const result = safeParse({
      camera: { enabled: true },
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });
});
