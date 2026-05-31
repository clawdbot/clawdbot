import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  OPENAI_ACCOUNT_WIZARD_GROUP,
  OPENAI_API_KEY_LABEL,
  OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
  OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
  OPENAI_CHATGPT_LOGIN_HINT,
  OPENAI_CHATGPT_LOGIN_LABEL,
} from "./auth-choice-copy.js";

async function runOpenAIProviderAuthMethod(
  methodId: string,
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const { buildOpenAIProvider } = await import("./openai-provider.js");
  const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
  if (!method) {
    return { profiles: [] };
  }
  return method.run(ctx);
}

export function buildOpenAISetupProvider(): ProviderPlugin {
  const oauthMethod = {
    id: "oauth",
    label: OPENAI_CHATGPT_LOGIN_LABEL,
    hint: OPENAI_CHATGPT_LOGIN_HINT,
    kind: "oauth",
    wizard: {
      choiceId: "openai",
      choiceLabel: OPENAI_CHATGPT_LOGIN_LABEL,
      choiceHint: OPENAI_CHATGPT_LOGIN_HINT,
      assistantPriority: -40,
      assistantVisibility: "manual-only",
      ...OPENAI_ACCOUNT_WIZARD_GROUP,
    },
    run: async (ctx) => runOpenAIProviderAuthMethod("oauth", ctx),
  } satisfies ProviderAuthMethod;

  const deviceCodeMethod = {
    id: "device-code",
    label: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
    hint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
    kind: "device_code",
    wizard: {
      choiceId: "openai-device-code",
      choiceLabel: OPENAI_CHATGPT_DEVICE_PAIRING_LABEL,
      choiceHint: OPENAI_CHATGPT_DEVICE_PAIRING_HINT,
      assistantPriority: -10,
      assistantVisibility: "manual-only",
      ...OPENAI_ACCOUNT_WIZARD_GROUP,
    },
    run: async (ctx) => runOpenAIProviderAuthMethod("device-code", ctx),
  } satisfies ProviderAuthMethod;

  const apiKeyMethod = {
    id: "api-key",
    label: OPENAI_API_KEY_LABEL,
    hint: "Use your OpenAI API key directly",
    kind: "api_key",
    wizard: {
      choiceId: "openai-api-key",
      choiceLabel: OPENAI_API_KEY_LABEL,
      choiceHint: "Use your OpenAI API key directly",
      assistantPriority: 5,
      ...OPENAI_ACCOUNT_WIZARD_GROUP,
    },
    run: async (ctx) => runOpenAIProviderAuthMethod("api-key", ctx),
  } satisfies ProviderAuthMethod;

  return {
    id: "openai",
    label: "OpenAI",
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [oauthMethod, deviceCodeMethod, apiKeyMethod],
  };
}

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Setup",
  description: "Lightweight OpenAI setup hooks",
  register(api) {
    api.registerProvider(buildOpenAISetupProvider());
  },
});
