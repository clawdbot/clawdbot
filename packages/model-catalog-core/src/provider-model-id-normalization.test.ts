import { describe, expect, it } from "vitest";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelIdWithPolicies,
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
  });
});
