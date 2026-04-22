import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import { TOKENHUB_MODEL_CATALOG, TOKENHUB_PROVIDER_ID } from "./models.js";
import { applyTokenHubConfig, TOKENHUB_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildTokenHubProvider } from "./provider-catalog.js";

function buildStaticCatalogEntries(providerId: string, catalog: typeof TOKENHUB_MODEL_CATALOG) {
  return catalog.map((entry) => ({
    provider: providerId,
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    contextWindow: entry.contextWindow,
  }));
}

export default definePluginEntry({
  id: "tencent",
  name: "Tencent Cloud Provider",
  description: "Bundled Tencent Cloud provider plugin (TokenHub)",
  register(api) {
    api.registerProvider({
      id: TOKENHUB_PROVIDER_ID,
      label: "Tencent TokenHub",
      docsPath: "/providers/tencent",
      envVars: ["TOKENHUB_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: TOKENHUB_PROVIDER_ID,
          methodId: "api-key",
          label: "Tencent TokenHub",
          hint: "Hy via Tencent TokenHub Gateway",
          optionKey: "tokenhubApiKey",
          flagName: "--tokenhub-api-key",
          envVar: "TOKENHUB_API_KEY",
          promptMessage: "Enter Tencent TokenHub API key",
          defaultModel: TOKENHUB_DEFAULT_MODEL_REF,
          expectedProviders: [TOKENHUB_PROVIDER_ID],
          applyConfig: (cfg) => applyTokenHubConfig(cfg),
          wizard: {
            choiceId: "tokenhub-api-key",
            choiceLabel: "Tencent TokenHub",
            groupId: "tencent",
            groupLabel: "Tencent Cloud",
            groupHint: "Tencent TokenHub",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: TOKENHUB_PROVIDER_ID,
            buildProvider: buildTokenHubProvider,
          }),
      },
      augmentModelCatalog: () =>
        buildStaticCatalogEntries(TOKENHUB_PROVIDER_ID, TOKENHUB_MODEL_CATALOG),
    });
  },
});
