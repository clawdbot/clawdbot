import { describe, expect, it } from "vitest";
import {
  resolveCapabilityModelRefForProviders,
  resolveCapabilityProviderModelOnlyRef,
} from "./capability-model-ref.js";
import { parseGenerationModelRef } from "./model-ref.js";

describe("media-generation model refs", () => {
  it("parses provider/model refs without splitting slash-containing model ids", () => {
    expect(parseGenerationModelRef("fal/fal-ai/flux/dev")).toEqual({
      provider: "fal",
      model: "fal-ai/flux/dev",
    });
  });

  it("rejects incomplete provider/model refs", () => {
    expect(parseGenerationModelRef(undefined)).toBeNull();
    expect(parseGenerationModelRef("openai")).toBeNull();
    expect(parseGenerationModelRef("/gpt-image-2")).toBeNull();
    expect(parseGenerationModelRef("openai/")).toBeNull();
  });

  it("resolves model-only refs from provider metadata", () => {
    expect(
      resolveCapabilityProviderModelOnlyRef({
        raw: "fal-ai/flux/dev",
        providers: [
          {
            id: "fal",
            defaultModel: "fal-ai/flux/dev",
            models: ["fal-ai/flux/dev/image-to-image"],
          },
        ],
      }),
    ).toEqual({ provider: "fal", model: "fal-ai/flux/dev" });
  });

  it("keeps explicit provider refs ahead of colliding model-only refs", () => {
    expect(
      resolveCapabilityModelRefForProviders({
        raw: "google/lyria-3-pro-preview",
        parseModelRef: parseGenerationModelRef,
        providers: [
          {
            id: "google",
            defaultModel: "lyria-3-clip-preview",
            models: ["lyria-3-pro-preview"],
          },
          {
            id: "openrouter",
            defaultModel: "google/lyria-3-pro-preview",
          },
        ],
      }),
    ).toEqual({ provider: "google", model: "lyria-3-pro-preview" });
  });

  it("matches provider aliases through a caller-supplied normalizer", () => {
    expect(
      resolveCapabilityModelRefForProviders({
        raw: "openai/gpt-image-2",
        parseModelRef: parseGenerationModelRef,
        normalizeProviderId: (value) => value.toLowerCase(),
        providers: [
          {
            id: "openai",
            aliases: ["openai"],
            defaultModel: "gpt-image-2",
          },
        ],
      }),
    ).toEqual({ provider: "openai", model: "gpt-image-2" });
  });
});
