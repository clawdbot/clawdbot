import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  OPENAI_API_KEY_LABEL,
  OPENAI_API_KEY_WIZARD_GROUP,
  OPENAI_CODEX_DEVICE_PAIRING_HINT,
  OPENAI_CODEX_DEVICE_PAIRING_LABEL,
  OPENAI_CODEX_LOGIN_HINT,
  OPENAI_CODEX_LOGIN_LABEL,
  OPENAI_CODEX_WIZARD_GROUP,
} from "./auth-choice-copy.js";
import { buildOpenAICodexCliBackend } from "./cli-backend.js";

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

async function runOpenAICodexProviderAuthMethod(
  methodId: string,
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const { buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js");
  const method = buildOpenAICodexProviderPlugin().auth.find((entry) => entry.id === methodId);
  if (!method) {
    return { profiles: [] };
  }
  return method.run(ctx);
}

function buildOpenAISetupProvider(): ProviderPlugin {
  const apiKeyMethod = {
    id: "api-key",
    label: OPENAI_API_KEY_LABEL,
    hint: "Use your OpenAI API key directly",
    kind: "api_key",
    wizard: {
      choiceId: "openai-api-key",
      choiceLabel: OPENAI_API_KEY_LABEL,
      ...OPENAI_API_KEY_WIZARD_GROUP,
    },
    run: async (ctx) => runOpenAIProviderAuthMethod("api-key", ctx),
  } satisfies ProviderAuthMethod;

  return {
    id: "openai",
    label: "OpenAI",
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [apiKeyMethod],
  };
}

function buildOpenAICodexSetupProvider(): ProviderPlugin {
  const oauthMethod = {
    id: "oauth",
    label: OPENAI_CODEX_LOGIN_LABEL,
    hint: OPENAI_CODEX_LOGIN_HINT,
    kind: "oauth",
    wizard: {
      choiceId: "openai-codex",
      choiceLabel: OPENAI_CODEX_LOGIN_LABEL,
      choiceHint: OPENAI_CODEX_LOGIN_HINT,
      assistantPriority: -30,
      ...OPENAI_CODEX_WIZARD_GROUP,
    },
    run: async (ctx) => runOpenAICodexProviderAuthMethod("oauth", ctx),
  } satisfies ProviderAuthMethod;

  const deviceCodeMethod = {
    id: "device-code",
    label: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
    hint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
    kind: "device_code",
    wizard: {
      choiceId: "openai-codex-device-code",
      choiceLabel: OPENAI_CODEX_DEVICE_PAIRING_LABEL,
      choiceHint: OPENAI_CODEX_DEVICE_PAIRING_HINT,
      assistantPriority: -10,
      ...OPENAI_CODEX_WIZARD_GROUP,
    },
    run: async (ctx) => runOpenAICodexProviderAuthMethod("device-code", ctx),
  } satisfies ProviderAuthMethod;

  return {
    id: "openai-codex",
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    auth: [oauthMethod, deviceCodeMethod],
  };
}

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Setup",
  description: "Lightweight OpenAI setup hooks",
  register(api) {
    api.registerProvider(buildOpenAISetupProvider());
    api.registerProvider(buildOpenAICodexSetupProvider());
    api.registerCliBackend(buildOpenAICodexCliBackend());
  },
});
