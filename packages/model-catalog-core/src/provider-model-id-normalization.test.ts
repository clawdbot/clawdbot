import { describe, expect, it } from "vitest";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelIdWithPolicies,
  stripSelfProviderModelPrefix,
} from "./provider-model-id-normalization.js";

describe("provider model id policy normalization", () => {
  it("applies manifest policies before built-in provider normalization", () => {
    const policies = collectManifestModelIdNormalizationPolicies([
      {
        modelIdNormalization: {
          providers: {
            "Google-Vertex": {
              aliases: {
                pro: "gemini-3-pro",
              },
            },
          },
        },
      },
    ]);

    expect(normalizeStaticProviderModelIdWithPolicies("google-vertex", "pro", policies)).toBe(
      "gemini-3.1-pro-preview",
    );
  });

  it("normalizes provider-prefixed Google catalog refs behind gateway prefixes", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId(
        "openrouter",
        "openrouter/google/gemini-3-pro-preview",
      ),
    ).toBe("openrouter/google/gemini-3.1-pro-preview");
    expect(
      normalizeConfiguredProviderCatalogModelId("openrouter", "openrouter/google/gemma-4-26b"),
    ).toBe("openrouter/google/gemma-4-26b-a4b-it");
  });

  it("normalizes native Anthropic catalog refs without retaining the provider prefix", () => {
    expect(
      normalizeStaticProviderModelIdWithPolicies("anthropic", "anthropic/claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5");
    expect(
      normalizeConfiguredProviderCatalogModelId("anthropic", "anthropic/claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5");
  });

  it("normalizes provider-prefixed native catalog refs without stripping catalog prefixes", () => {
    expect(normalizeStaticProviderModelIdWithPolicies("google", "google/gemini-2.0-flash")).toBe(
      "google/gemini-2.0-flash",
    );
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "google-gemini-cli",
        "google-gemini-cli/gemini-2.0-flash",
      ),
    ).toBe("google-gemini-cli/gemini-2.0-flash");
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "google-vertex",
        "google-vertex/gemini-3-pro-preview",
      ),
    ).toBe("google-vertex/gemini-3-pro-preview");
    expect(normalizeStaticProviderModelIdWithPolicies("xai", "xai/grok-4-fast-reasoning")).toBe(
      "xai/grok-4-fast-reasoning",
    );
    expect(normalizeStaticProviderModelIdWithPolicies("openai", "openai/gpt-5.4")).toBe(
      "openai/gpt-5.4",
    );
    expect(
      normalizeStaticProviderModelIdWithPolicies("vercel-ai-gateway", "vercel-ai-gateway/opus-4.6"),
    ).toBe("vercel-ai-gateway/opus-4.6");
  });

  it("strips self provider model prefixes before runtime provider calls", () => {
    expect(stripSelfProviderModelPrefix("google", "google/gemini-2.0-flash")).toBe(
      "gemini-2.0-flash",
    );
    expect(stripSelfProviderModelPrefix("xai", "xai/grok-4-fast-reasoning")).toBe(
      "grok-4-fast-reasoning",
    );
    expect(stripSelfProviderModelPrefix("openai", "openai/gpt-5.4")).toBe("gpt-5.4");
    expect(stripSelfProviderModelPrefix("vercel-ai-gateway", "vercel-ai-gateway/opus-4.6")).toBe(
      "opus-4.6",
    );
  });
});
