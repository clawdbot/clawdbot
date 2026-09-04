/** Tests provider config runtime-snapshot comparison and its hash memoization. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { providerConfigMatchesRuntimeSnapshot } from "./model-auth-provider-config-compare.js";

function makeConfig(provider: string, model: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: `https://example.com/${provider}`,
          apiKey: "test-key",
          models: [{ id: model, name: model, reasoning: false, input: ["text"], cost: {} }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("providerConfigMatchesRuntimeSnapshot", () => {
  it("matches identical provider configs", () => {
    const runtime = makeConfig("openai", "gpt-5.6-sol");
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: runtime,
        runtimeConfig: runtime,
        provider: "openai",
      }),
    ).toBe(true);
  });

  it("matches equivalent configs built as distinct objects", () => {
    const input = makeConfig("openai", "gpt-5.6-sol");
    const runtime = makeConfig("openai", "gpt-5.6-sol");
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: input,
        runtimeConfig: runtime,
        provider: "openai",
      }),
    ).toBe(true);
  });

  it("rejects provider configs with different models", () => {
    const input = makeConfig("openai", "gpt-5.6-sol");
    const runtime = makeConfig("openai", "gpt-5.6-mini");
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: input,
        runtimeConfig: runtime,
        provider: "openai",
      }),
    ).toBe(false);
  });

  it("returns false when the provider is missing from either side", () => {
    const runtime = makeConfig("openai", "gpt-5.6-sol");
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: undefined,
        runtimeConfig: runtime,
        provider: "missing",
      }),
    ).toBe(false);
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: runtime,
        runtimeConfig: null,
        provider: "missing",
      }),
    ).toBe(false);
  });

  it("keeps per-object memoization entries independent across reloads", () => {
    const before = makeConfig("openai", "gpt-5.6-sol");
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: before,
        runtimeConfig: before,
        provider: "openai",
      }),
    ).toBe(true);

    // A reload installs a NEW config object with different content; the old
    // object's memoized hash must not leak into the new object's comparison.
    const after = makeConfig("openai", "gpt-5.6-mini");
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: after,
        runtimeConfig: after,
        provider: "openai",
      }),
    ).toBe(true);

    // Cross-object comparisons use each object's OWN memoized hash.
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: before,
        runtimeConfig: after,
        provider: "openai",
      }),
    ).toBe(false);
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: after,
        runtimeConfig: before,
        provider: "openai",
      }),
    ).toBe(false);

    // Re-asking the pre-reload object still evaluates against its own entry.
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: before,
        runtimeConfig: before,
        provider: "openai",
      }),
    ).toBe(true);
  });

  it("returns stable results across repeated lifecycle-style calls", () => {
    const input = makeConfig("openai", "gpt-5.6-sol");
    const runtime = makeConfig("openai", "gpt-5.6-sol");
    const results = Array.from({ length: 5 }, () =>
      providerConfigMatchesRuntimeSnapshot({
        inputConfig: input,
        runtimeConfig: runtime,
        provider: "openai",
      }),
    );
    expect(results).toEqual([true, true, true, true, true]);
  });
});
