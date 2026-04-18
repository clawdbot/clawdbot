import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });
const wizardGroup = {
  groupId: "minimax",
  groupLabel: "MiniMax",
  groupHint: "M2.7 (recommended)",
} as const;

export function createMinimaxProvider(): ProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    hookAliases: ["minimax-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_API_KEY"],
    auth: [
      {
        id: "api-global",
        kind: "api_key",
        label: "MiniMax API key (Global)",
        hint: "Global endpoint - api.minimax.io",
        run: noopAuth,
        wizard: {
          choiceId: "minimax-global-api",
          choiceLabel: "MiniMax API key (Global)",
          choiceHint: "Global endpoint - api.minimax.io",
          ...wizardGroup,
        },
      },
      {
        id: "api-cn",
        kind: "api_key",
        label: "MiniMax API key (CN)",
        hint: "CN endpoint - api.minimaxi.com",
        run: noopAuth,
        wizard: {
          choiceId: "minimax-cn-api",
          choiceLabel: "MiniMax API key (CN)",
          choiceHint: "CN endpoint - api.minimaxi.com",
          ...wizardGroup,
        },
      },
    ],
  };
}

export function createMinimaxPortalProvider(): ProviderPlugin {
  return {
    id: "minimax-portal",
    label: "MiniMax",
    hookAliases: ["minimax-portal-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
    auth: [
      {
        id: "oauth",
        kind: "device_code",
        label: "MiniMax OAuth (Global)",
        hint: "Global endpoint - api.minimax.io",
        run: noopAuth,
        wizard: {
          choiceId: "minimax-global-oauth",
          choiceLabel: "MiniMax OAuth (Global)",
          choiceHint: "Global endpoint - api.minimax.io",
          ...wizardGroup,
        },
      },
      {
        id: "oauth-cn",
        kind: "device_code",
        label: "MiniMax OAuth (CN)",
        hint: "CN endpoint - api.minimaxi.com",
        run: noopAuth,
        wizard: {
          choiceId: "minimax-cn-oauth",
          choiceLabel: "MiniMax OAuth (CN)",
          choiceHint: "CN endpoint - api.minimaxi.com",
          ...wizardGroup,
        },
      },
    ],
  };
}
