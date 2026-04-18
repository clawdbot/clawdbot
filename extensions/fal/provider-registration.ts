import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { applyFalConfig, FAL_DEFAULT_IMAGE_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "fal";

export function createFalProvider(): ProviderPlugin {
  return {
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
  };
}
