/**
 * Apiário provider plugin entry.
 */
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyApiarioConfig, APIARIO_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildApiarioProvider } from "./provider-catalog.js";

const PROVIDER_ID = "apiario";

async function resolveApiarioCatalog(ctx: {
  resolveProviderApiKey: (provider: string) => { apiKey?: string; discoveryApiKey?: string };
}) {
  const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  if (!apiKey) {
    return null;
  }

  return {
    provider: await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: PROVIDER_ID,
      providerConfig: buildApiarioProvider(),
      apiKey,
      discoveryApiKey: apiKey,
    }),
  };
}

/** Provider entry for Apiário. */
export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Apiário Provider",
  description: "Bundled Apiário provider plugin",
  provider: {
    label: "Apiário",
    docsPath: "/providers/apiario",
    envVars: ["APIARIO_API_KEY"],
    auth: [
      {
        methodId: "apiario-api-key",
        label: "Apiário API Key",
        hint: "Use sua chave da API do Apiário Dev",
        optionKey: "apiarioApiKey",
        flagName: "--apiario-api-key",
        envVar: "APIARIO_API_KEY",
        promptMessage: "Enter your Apiário API key",
        defaultModel: APIARIO_DEFAULT_MODEL_REF,
        applyConfig: applyApiarioConfig,
      },
    ],
    catalog: {
      run: resolveApiarioCatalog,
      staticRun: async () => ({ provider: buildApiarioProvider() }),
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
  },
});
