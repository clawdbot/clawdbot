import { describe, expect, it } from "vitest";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionActiveAutoModelFallback,
} from "./model-override-provenance.js";

describe("hasLegacyAutoFallbackWithoutOrigin", () => {
  it.each([
    {
      name: "origin-backed automatic override",
      entry: {
        modelOverrideSource: "auto" as const,
        modelOverrideFallbackOriginProvider: "anthropic",
        modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      },
      expected: false,
    },
    {
      name: "blank origin provider",
      entry: {
        modelOverrideSource: "auto" as const,
        modelOverrideFallbackOriginProvider: " ",
        modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      },
      expected: true,
    },
    {
      name: "missing origin model",
      entry: {
        modelOverrideSource: "auto" as const,
        modelOverrideFallbackOriginProvider: "anthropic",
      },
      expected: true,
    },
    {
      name: "user override",
      entry: { modelOverrideSource: "user" as const },
      expected: false,
    },
    {
      name: "unmarked override",
      entry: {},
      expected: false,
    },
  ])("returns $expected for $name", ({ entry, expected }) => {
    expect(hasLegacyAutoFallbackWithoutOrigin(entry)).toBe(expected);
  });

  it("returns false for a missing entry", () => {
    expect(hasLegacyAutoFallbackWithoutOrigin(undefined)).toBe(false);
  });
});

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
