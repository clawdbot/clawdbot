import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createAnthropicProvider(): ProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic",
    docsPath: "/providers/models",
    hookAliases: ["claude-cli"],
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    auth: [
      {
        id: "cli",
        kind: "custom",
        label: "Claude CLI",
        hint: "Reuse a local Claude CLI login and switch model selection to claude-cli/*",
        run: noopAuth,
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          choiceHint: "Reuse a local Claude CLI login on this host",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
        },
      },
      {
        id: "setup-token",
        kind: "token",
        label: "Anthropic setup-token",
        hint: "Manual bearer token path",
        run: noopAuth,
        wizard: {
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          choiceHint: "Manual token path",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key + token",
        },
      },
      {
        id: "api-key",
        kind: "api_key",
        label: "Anthropic API key",
        hint: "Direct Anthropic API key",
        run: noopAuth,
        wizard: {
          choiceId: "apiKey",
          choiceLabel: "Anthropic API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
        },
      },
    ],
  };
}
