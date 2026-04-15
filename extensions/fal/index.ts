import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildFalImageGenerationProvider } from "./image-generation-provider.js";
import { applyFalConfig, FAL_DEFAULT_IMAGE_MODEL_REF } from "./onboard.js";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "fal";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "fal Provider",
  description: "Bundled fal image and video generation provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "fal",
      docsPath: "/providers/models",
      envVars: ["FAL_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "fal API key",
          hint: "Image and video generation API key",
          optionKey: "falApiKey",
          flagName: "--fal-api-key",
          envVar: "FAL_KEY",
          promptMessage: "Enter fal API key",
          defaultModel: FAL_DEFAULT_IMAGE_MODEL_REF,
          expectedProviders: ["fal"],
          applyConfig: (cfg) => applyFalConfig(cfg),
          wizard: {
            choiceId: "fal-api-key",
            choiceLabel: "fal API key",
            choiceHint: "Image and video generation API key",
            groupId: "fal",
            groupLabel: "fal",
            groupHint: "Image and video generation",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerImageGenerationProvider(buildFalImageGenerationProvider());
    api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
  },
});
