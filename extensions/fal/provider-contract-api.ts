import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "fal";
const FAL_DEFAULT_IMAGE_MODEL_REF = "fal/fal-ai/flux/dev";

export function createFalProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "fal",
    docsPath: "/providers/models",
    envVars: ["FAL_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "fal API key",
        hint: "Image, video, and music generation API key",
        run: async () => ({ profiles: [], defaultModel: FAL_DEFAULT_IMAGE_MODEL_REF }),
        wizard: {
          choiceId: "fal-api-key",
          choiceLabel: "fal API key",
          choiceHint: "Image, video, and music generation API key",
          groupId: "fal",
          groupLabel: "fal",
          groupHint: "Image, video, and music generation",
          onboardingScopes: ["image-generation", "music-generation"],
        },
      },
    ],
  };
}
