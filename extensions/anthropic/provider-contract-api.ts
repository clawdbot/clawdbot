/**
 * Contract API for Anthropic provider metadata. It builds a provider descriptor
 * without runtime registration side effects.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

/** Create the static Anthropic provider contract descriptor. */
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
        hint: "Keep using a local Claude CLI login and run Anthropic models through the Claude CLI runtime",
        run: noopAuth,
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          choiceHint: "Keep using an existing Claude Code CLI login on this host",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude CLI + API key",
        },
      },
      {
        id: "setup-token",
        kind: "token",
        label: "Anthropic setup-token",
        hint: "Paste a long-lived token created with 'claude setup-token'",
        run: noopAuth,
        wizard: {
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          choiceHint: "Token created by running 'claude setup-token' in your terminal",
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
