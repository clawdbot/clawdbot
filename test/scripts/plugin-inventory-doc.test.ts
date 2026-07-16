import { describe, expect, it } from "vitest";
import { resolvePluginSurface } from "../../scripts/lib/plugin-inventory-doc.mjs";

describe("resolvePluginSurface", () => {
  it("keeps manifest identifiers as inline code while leaving labels visible", () => {
    expect(
      resolvePluginSurface({
        channels: ["discord"],
        providers: ["openai"],
        contracts: {
          webSearchProviders: {},
          tools: {},
        },
        skills: ["example"],
      }),
    ).toBe(
      "channels: `discord`; providers: `openai`; contracts: `tools`, `webSearchProviders`; skills",
    );
  });

  it("retains the generic fallback", () => {
    expect(resolvePluginSurface({})).toBe("plugin");
  });
});
