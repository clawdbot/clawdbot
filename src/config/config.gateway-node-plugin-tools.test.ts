import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("gateway node plugin tools config", () => {
  it("leaves node plugin tools enabled by runtime default when unset", () => {
    const result = validateConfigObject({ gateway: { nodes: {} } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.nodes?.pluginTools?.enabled).toBeUndefined();
    }
  });

  it.each([true, false])("accepts enabled=%s", (enabled) => {
    const result = validateConfigObject({
      gateway: { nodes: { pluginTools: { enabled } } },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects non-boolean enabled values", () => {
    const result = validateConfigObject({
      gateway: { nodes: { pluginTools: { enabled: "yes" } } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path === "gateway.nodes.pluginTools.enabled"),
      ).toBe(true);
    }
  });
});
