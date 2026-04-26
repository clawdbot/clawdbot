import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import { DOUBAO_CODING_MODEL_CATALOG, DOUBAO_MODEL_CATALOG } from "./models.js";
import { buildDoubaoCodingProvider, buildDoubaoProvider } from "./provider-catalog.js";
import { buildVolcengineSpeechProvider } from "./speech-provider.js";

const PROVIDER_ID = "volcengine";
const VOLCENGINE_DEFAULT_MODEL_REF = "volcengine-plan/ark-code-latest";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Volcengine Provider",
  description: "Bundled Volcengine provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Volcengine",
      docsPath: "/concepts/model-providers#volcano-engine-doubao",
      envVars: ["VOLCANO_ENGINE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Volcano Engine API key",
          hint: "API key",
          optionKey: "volcengineApiKey",
          flagName: "--volcengine-api-key",
          envVar: "VOLCANO_ENGINE_API_KEY",
          promptMessage: "Enter Volcano Engine API key",
          defaultModel: VOLCENGINE_DEFAULT_MODEL_REF,
          expectedProviders: ["volcengine"],
          applyConfig: (cfg) =>
            ensureModelAllowlistEntry({
              cfg,
              modelRef: VOLCENGINE_DEFAULT_MODEL_REF,
            }),
          wizard: {
            choiceId: "volcengine-api-key",
            choiceLabel: "Volcano Engine API key",
            groupId: "volcengine",
            groupLabel: "Volcano Engine",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "paired",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            providers: {
              volcengine: { ...buildDoubaoProvider(), apiKey },
              "volcengine-plan": { ...buildDoubaoCodingProvider(), apiKey },
            },
          };
        },
      },
      augmentModelCatalog: () => {
        const volcengineModels = DOUBAO_MODEL_CATALOG.map((entry) => ({
          provider: "volcengine",
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: [...entry.input],
          contextWindow: entry.contextWindow,
        }));
        const volcenginePlanModels = DOUBAO_CODING_MODEL_CATALOG.map((entry) => ({
          provider: "volcengine-plan",
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: [...entry.input],
          contextWindow: entry.contextWindow,
        }));
        return [...volcengineModels, ...volcenginePlanModels];
      },
    });
    api.registerSpeechProvider(buildVolcengineSpeechProvider());
  },
});
