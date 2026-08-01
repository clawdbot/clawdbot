import { describe, expect, it } from "vitest";
import { hasSessionActiveAutoModelFallback } from "./model-override-provenance.js";

describe("hasSessionActiveAutoModelFallback", () => {
  it.each([
    {
      name: "different automatic selection",
      entry: {
        providerOverride: "fallback",
        modelOverride: "secondary",
        modelOverrideSource: "auto" as const,
        modelOverrideFallbackOriginProvider: "primary",
        modelOverrideFallbackOriginModel: "main",
      },
      expected: true,
    },
    {
      name: "legacy fallback provenance",
      entry: {
        providerOverride: "fallback",
        modelOverride: "secondary",
        modelOverrideFallbackOriginProvider: "primary",
        modelOverrideFallbackOriginModel: "main",
      },
      expected: true,
    },
    {
      name: "self-origin configured selection",
      entry: {
        providerOverride: "primary",
        modelOverride: "main",
        modelOverrideSource: "auto" as const,
        modelOverrideFallbackOriginProvider: "primary",
        modelOverrideFallbackOriginModel: "main",
      },
      expected: false,
    },
    {
      name: "user selection with stale provenance",
      entry: {
        providerOverride: "fallback",
        modelOverride: "secondary",
        modelOverrideSource: "user" as const,
        modelOverrideFallbackOriginProvider: "primary",
        modelOverrideFallbackOriginModel: "main",
      },
      expected: false,
    },
  ])("returns $expected for $name", ({ entry, expected }) => {
    expect(hasSessionActiveAutoModelFallback(entry)).toBe(expected);
  });
});
