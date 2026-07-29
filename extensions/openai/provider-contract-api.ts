// Openai API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  OPENAI_ACCOUNT_WIZARD_GROUP,
  OPENAI_API_KEY_LABEL,
  OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
  OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
  OPENAI_CHATGPT_LOGIN_HINT,
  OPENAI_CHATGPT_LOGIN_LABEL,
} from "./auth-choice-copy.js";

const noopAuth = async () => ({ profiles: [] });

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
          assistantVisibility: "manual-only",
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
      {
        id: "api-key",
        kind: "api_key",
        label: OPENAI_API_KEY_LABEL,
        hint: "Use your OpenAI API key directly",
        run: noopAuth,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: OPENAI_API_KEY_LABEL,
          choiceHint: "Use your OpenAI API key directly",
          assistantPriority: 5,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
    ],
  };
}
