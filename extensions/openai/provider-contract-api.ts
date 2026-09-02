// Openai API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_API_KEY_LABEL = "OpenAI API Key";
const OPENAI_CHATGPT_LOGIN_LABEL = "ChatGPT Login";
const OPENAI_CHATGPT_LOGIN_HINT = "Sign in with your ChatGPT or Codex subscription";
const OPENAI_CHATGPT_DEVICE_PAIRING_LABEL = "ChatGPT Device Pairing";
const OPENAI_CHATGPT_DEVICE_PAIRING_HINT =
  "Pair your ChatGPT account in browser with a device code";
const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "ChatGPT/Codex sign-in or API key",
} as const;
const CODEX_API_KEY_IMPORT = {
  migrationProviderId: "codex",
  itemId: "auth:openai:api-key",
  credentialKind: "api_key",
} as const;

export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: OPENAI_CHATGPT_LOGIN_LABEL,
        hint: OPENAI_CHATGPT_LOGIN_HINT,
        run: noopAuth,
        wizard: {
          choiceId: "openai",
          choiceLabel: OPENAI_CHATGPT_LOGIN_LABEL,
          choiceHint: OPENAI_CHATGPT_LOGIN_HINT,
          assistantPriority: -40,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "device-code",
        kind: "device_code",
        label: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
        hint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
        run: noopAuth,
        wizard: {
          choiceId: "openai-device-code",
          choiceLabel: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
          choiceHint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
          assistantPriority: -10,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "api-key",
        kind: "api_key",
        label: OPENAI_API_KEY_LABEL,
        hint: "Use your OpenAI API key directly",
        credentialImport: CODEX_API_KEY_IMPORT,
        run: noopAuth,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: OPENAI_API_KEY_LABEL,
          choiceHint: "Use your OpenAI API key directly",
          assistantPriority: 5,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
    ],
  };
}
