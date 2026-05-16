import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  OPENAI_ACCOUNT_WIZARD_GROUP,
  OPENAI_API_KEY_LABEL,
  OPENAI_CODEX_DEVICE_PAIRING_HINT,
  OPENAI_CODEX_DEVICE_PAIRING_LABEL,
  OPENAI_CODEX_LOGIN_HINT,
  OPENAI_CODEX_LOGIN_LABEL,
  OPENAI_CODEX_WIZARD_GROUP,
} from "./auth-choice-copy.js";

const noopAuth = async () => ({ profiles: [] });

export function createOpenAICodexProvider(): ProviderPlugin {
  return {
    id: "openai-codex",
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    oauthProfileIdRepairs: [
      {
        legacyProfileId: "openai-codex:default",
        promptLabel: "OpenAI Codex",
      },
    ],
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: OPENAI_CODEX_LOGIN_LABEL,
        hint: OPENAI_CODEX_LOGIN_HINT,
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex",
          choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
          choiceHint: OPENAI_CODEX_LOGIN_HINT,
          assistantPriority: -30,
          onboardingFeatured: true,
          ...OPENAI_CODEX_WIZARD_GROUP,
        },
      },
      {
        id: "device-code",
        kind: "device_code",
        label: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
        hint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex-device-code",
          choiceLabel: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
          choiceHint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
          assistantPriority: -10,
          ...OPENAI_CODEX_WIZARD_GROUP,
        },
      },
    ],
  };
}

export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
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
