import { describe, expect, it } from "vitest";
import {
  hasSessionActiveAutoModelFallback,
  hasUserPinnedModelSelection,
  resolveSessionModelOverrideSource,
} from "./model-override-provenance.js";

describe("hasUserPinnedModelSelection", () => {
  it.each([
    {
      name: "legacy user override",
      entry: { providerOverride: "openai", modelOverride: "gpt-5.6-sol" },
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
      expected: false,
    },
  ])("returns $expected for $name", ({ entry, expected }) => {
    expect(hasUserPinnedModelSelection(entry)).toBe(expected);
  });

  it("preserves truthy status classification before resolver normalization", () => {
    const entry = { modelOverride: "  ", modelOverrideSource: "user" as const };

    expect(hasUserPinnedModelSelection(entry)).toBe(true);
    expect(resolveSessionModelOverrideSource(entry)).toBeNull();
  });
});

describe("resolveSessionModelOverrideSource", () => {
  it.each([
    { name: "inherited selection", entry: undefined, expected: null },
    {
      name: "explicit user pin",
      entry: { modelOverride: "gpt-5.6-sol", modelOverrideSource: "user" as const },
      expected: "user",
    },
    {
      name: "automatic fallback",
      entry: { modelOverride: "fallback", modelOverrideSource: "auto" as const },
      expected: "auto",
    },
    {
      name: "legacy user pin",
      entry: { providerOverride: "openai", modelOverride: "gpt-5.6-sol" },
      expected: "user",
    },
    {
      name: "legacy automatic fallback",
      entry: {
        providerOverride: "fallback",
        modelOverride: "secondary",
        modelOverrideFallbackOriginProvider: "primary",
        modelOverrideFallbackOriginModel: "main",
      },
      expected: "auto",
    },
  ])("returns $expected for $name", ({ entry, expected }) => {
    expect(resolveSessionModelOverrideSource(entry)).toBe(expected);
  });
});

describe("hasSessionActiveAutoModelFallback", () => {
  it.each([
    {
      name: "configured automatic selection without fallback provenance",
      entry: {
        providerOverride: "fallback",
        modelOverride: "secondary",
        modelOverrideSource: "auto" as const,
      },
      expected: false,
    },
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
