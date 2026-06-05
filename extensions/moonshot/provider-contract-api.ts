// Moonshot API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createMoonshotProvider(): ProviderPlugin {
  return {
    id: "moonshot",
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "Kimi API key (.ai)",
        hint: "Kimi K2.6 + Kimi",
        run: noopAuth,
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.6)",
        },
      },
      {
        id: "api-key-cn",
        kind: "api_key",
        label: "Kimi API key (.cn)",
        hint: "Kimi K2.6 + Kimi",
        run: noopAuth,
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.6)",
        },
      },
    ],
  };
}
