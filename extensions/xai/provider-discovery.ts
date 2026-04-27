import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { readProviderEnvValue } from "openclaw/plugin-sdk/provider-web-search";
import { resolveFallbackXaiAuth } from "./src/tool-auth-shared.js";

const PROVIDER_ID = "xai";

function resolveXaiSyntheticAuth(config: unknown) {
  const apiKey =
    resolveFallbackXaiAuth(config as never)?.apiKey || readProviderEnvValue(["XAI_API_KEY"]);
  return apiKey
    ? {
        apiKey,
        source: "xAI plugin config",
        mode: "api-key" as const,
      }
    : undefined;
}

export const xaiProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "xAI",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ config }) => resolveXaiSyntheticAuth(config),
};

export default xaiProviderDiscovery;
