import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export function createXaiProvider(): ProviderPlugin {
  return {
    id: "xai",
    label: "xAI",
    aliases: ["x-ai"],
    docsPath: "/providers/xai",
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "xAI API key",
        hint: "API key",
        run: async () => ({ profiles: [] }),
        wizard: {
          groupLabel: "xAI (Grok)",
        },
      },
    ],
  };
}
