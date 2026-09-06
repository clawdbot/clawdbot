import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { PluginsCatalogBrowseResultSchema } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { buildPluginDiscoveryMock } from "../../scripts/control-ui-mock-plugins.js";

describe("Control UI plugin discovery preview", () => {
  it("provides visible ClawHub rows with valid joined local state", () => {
    const result = buildPluginDiscoveryMock();

    expect(Value.Check(PluginsCatalogBrowseResultSchema, result)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((plugin) => plugin.local.installed)).toBe(true);
    expect(result.items.some((plugin) => !plugin.local.installed)).toBe(true);
  });
});
