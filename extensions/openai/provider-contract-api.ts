import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "API key + Codex auth",
} as const;

export function createOpenAICodexProvider(): ProviderPlugin {
  return {
    id: "openai-codex",
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: "OpenAI Codex Browser Login",
        hint: "Sign in with OpenAI in your browser",
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex",
          choiceLabel: "OpenAI Codex Browser Login",
          choiceHint: "Sign in with OpenAI in your browser",
          assistantPriority: -30,
          ...OPENAI_WIZARD_GROUP,
        },
      },
      {
        id: "device-code",
        kind: "device_code",
        label: "OpenAI Codex Device Pairing",
        hint: "Pair in browser with a device code",
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex-device-code",
          choiceLabel: "OpenAI Codex Device Pairing",
          choiceHint: "Pair in browser with a device code",
          assistantPriority: -10,
          ...OPENAI_WIZARD_GROUP,
        },
      },
      {
        id: "import-codex-cli",
        kind: "oauth",
        label: "Import Existing Codex Login",
        hint: "Import an existing ~/.codex login",
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex-import",
          choiceLabel: "Import Existing Codex Login",
          choiceHint: "Import an existing ~/.codex login",
          assistantPriority: -20,
          ...OPENAI_WIZARD_GROUP,
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
        label: "OpenAI API Key",
        hint: "Use your OpenAI API key directly",
        run: noopAuth,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API Key",
          assistantPriority: -40,
          ...OPENAI_WIZARD_GROUP,
        },
      },
    ],
  };
}
