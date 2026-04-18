import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createMoonshotProvider(): ProviderPlugin {
  return {
    id: "moonshot",
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "Kimi API key (.ai)",
        hint: "Kimi K2.5 + Kimi",
        run: noopAuth,
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.5)",
        },
      },
      {
        id: "api-key-cn",
        kind: "api_key",
        label: "Kimi API key (.cn)",
        hint: "Kimi K2.5 + Kimi",
        run: noopAuth,
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.5)",
        },
      },
    ],
  };
}
