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
          groupHint: "API key",
        },
      },
    ],
  };
}
