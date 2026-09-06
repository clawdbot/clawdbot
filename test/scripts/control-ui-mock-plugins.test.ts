import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PluginsCatalogBrowseResultSchema,
  PluginsCatalogCategoriesResultSchema,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import {
  buildPluginDiscoveryCategoriesMock,
  buildPluginDiscoveryMock,
} from "../../scripts/control-ui-mock-plugins.js";

describe("Control UI plugin discovery preview", () => {
  it("provides visible ClawHub rows with valid joined local state", () => {
    const result = buildPluginDiscoveryMock();

    expect(Value.Check(PluginsCatalogBrowseResultSchema, result)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((plugin) => plugin.local.installed)).toBe(true);
    expect(result.items.some((plugin) => !plugin.local.installed)).toBe(true);
  });

  it("provides valid catalog categories for visual review", () => {
    const result = buildPluginDiscoveryCategoriesMock();

    expect(Value.Check(PluginsCatalogCategoriesResultSchema, result)).toBe(true);
    expect(result.categories.map((category) => category.slug)).toEqual([
      "channels",
      "models",
      "memory",
      "context",
      "voice",
      "media",
      "web",
      "tools",
      "runtime",
      "gateway",
      "security",
      "other",
    ]);
  });
});
