// Tencent plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  TOKENHUB_MODEL_CATALOG,
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_MODEL_CATALOG,
  TOKENPLAN_PROVIDER_ID,
} from "./models.js";
import {
  applyTokenHubConfig,
  TOKENHUB_DEFAULT_MODEL_REF,
  applyTokenPlanConfig,
  TOKENPLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./provider-catalog.js";
import { wrapTencentProviderStream } from "./stream.js";

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

function createTokenHubApiKeyAuthMethod() {
  return createProviderApiKeyAuthMethod({
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
    applyConfig: applyTokenHubConfig,
    wizard: {
      choiceId: "tokenhub-api-key",
      choiceLabel: "Tencent TokenHub",
      groupId: "tencent",
      groupLabel: "Tencent Cloud",
      groupHint: "Tencent TokenHub",
    },
  });
}

export default definePluginEntry({
  id: "tencent",
  name: "Tencent Cloud Provider",
  description: "Bundled Tencent Cloud provider plugin (TokenHub, TokenPlan)",
  register(api) {
    api.registerProvider({
      id: TOKENHUB_PROVIDER_ID,
      label: "Tencent TokenHub",
      docsPath: "/providers/tencent",
      envVars: ["TOKENHUB_API_KEY"],
      auth: [createTokenHubApiKeyAuthMethod()],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildOpenAICompatibleProviderCatalog({
            ctx,
            providerId: TOKENHUB_PROVIDER_ID,
            buildProvider: buildTokenHubProvider,
          }),
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildTokenHubProvider() }),
      },
      augmentModelCatalog: () =>
        buildStaticCatalogEntries(TOKENHUB_PROVIDER_ID, TOKENHUB_MODEL_CATALOG),
      wrapStreamFn: wrapTencentProviderStream,
    });

    api.registerProvider({
      id: TOKENPLAN_PROVIDER_ID,
      label: "Tencent TokenPlan",
      docsPath: "/providers/tencent",
      envVars: ["TOKENPLAN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: TOKENPLAN_PROVIDER_ID,
          methodId: "api-key",
          label: "Tencent TokenPlan",
          hint: "Hy via Tencent TokenPlan Gateway",
          optionKey: "tokenplanApiKey",
          flagName: "--tokenplan-api-key",
          envVar: "TOKENPLAN_API_KEY",
          promptMessage: "Enter Tencent TokenPlan API key",
          defaultModel: TOKENPLAN_DEFAULT_MODEL_REF,
          expectedProviders: [TOKENPLAN_PROVIDER_ID],
          applyConfig: applyTokenPlanConfig,
          wizard: {
            choiceId: "tokenplan-api-key",
            choiceLabel: "Tencent TokenPlan",
            groupId: "tencent",
            groupLabel: "Tencent Cloud",
            groupHint: "Tencent TokenPlan",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildOpenAICompatibleProviderCatalog({
            ctx,
            providerId: TOKENPLAN_PROVIDER_ID,
            buildProvider: buildTokenPlanProvider,
          }),
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildTokenPlanProvider() }),
      },
      augmentModelCatalog: () =>
        buildStaticCatalogEntries(TOKENPLAN_PROVIDER_ID, TOKENPLAN_MODEL_CATALOG),
      wrapStreamFn: wrapTencentProviderStream,
    });
  },
});
