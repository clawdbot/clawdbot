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
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        run: noopAuth,
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
      {
        id: "api-key-cn",
        kind: "api_key",
        label: "Kimi API key (.cn)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        run: noopAuth,
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
    ],
  };
}
