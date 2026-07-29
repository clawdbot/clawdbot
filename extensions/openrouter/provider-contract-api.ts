// Openrouter API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export function createOpenrouterProvider(): ProviderPlugin {
  return {
    id: "openrouter",
    label: "OpenRouter",
    docsPath: "/providers/models",
    envVars: ["OPENROUTER_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "OpenRouter API key",
        hint: "API key",
        run: async () => ({ profiles: [] }),
        wizard: {
          choiceId: "openrouter-api-key",
          choiceLabel: "OpenRouter API key",
          groupId: "openrouter",
          groupLabel: "OpenRouter",
          groupHint: "OAuth or API key",
          onboardingScopes: ["text-inference", "music-generation"],
        },
      },
      {
        id: "oauth",
        kind: "oauth",
        label: "OpenRouter OAuth",
        hint: "Browser sign-in",
        run: async () => ({ profiles: [] }),
        wizard: {
          choiceId: "openrouter-oauth",
          choiceLabel: "OpenRouter OAuth",
          choiceHint: "Browser sign-in",
          groupId: "openrouter",
          groupLabel: "OpenRouter",
          groupHint: "OAuth or API key",
          methodId: "oauth",
          onboardingScopes: ["text-inference", "music-generation"],
          onboardingFeatured: true,
        },
      },
    ],
  };
}
