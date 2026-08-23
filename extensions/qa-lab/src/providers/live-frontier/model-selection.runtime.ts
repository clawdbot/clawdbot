// Qa Lab plugin module implements model selection behavior.
import {
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth";

const QA_CODEX_OAUTH_LIVE_MODEL = "openai/gpt-5.6-luna";

export function resolveQaLiveFrontierAlternateModel(primaryModel: string) {
  const normalized = primaryModel.toLowerCase();
  if (normalized === QA_CODEX_OAUTH_LIVE_MODEL) {
    return "openai/gpt-5.6-sol";
  }
  return normalized === "openai/gpt-5.6" || normalized === "openai/gpt-5.6-sol"
    ? QA_CODEX_OAUTH_LIVE_MODEL
    : undefined;
}

export function resolveQaLiveFrontierPreferredModel() {
  if (resolveEnvApiKey("openai")?.apiKey) {
    return undefined;
  }
  try {
    const store = loadAuthProfileStoreForRuntime(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
      externalCliProviderIds: ["openai"],
    });
    const openAiProfileIds = listProfilesForProvider(store, "openai");
    const openAiProfileTypes = openAiProfileIds.map((profileId) => store.profiles[profileId]?.type);
    if (openAiProfileTypes.some((type) => type === "api_key")) {
      return undefined;
    }
    return openAiProfileTypes.some((type) => type === "oauth" || type === "token")
      ? QA_CODEX_OAUTH_LIVE_MODEL
      : undefined;
  } catch {
    return undefined;
  }
}
