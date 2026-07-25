// Volcengine plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import { applyVolcengineToolSchemaCompat } from "./api.js";
import { VOLCENGINE_PROVIDER_CATALOG_ENTRIES } from "./provider-catalog.js";
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
      hookAliases: ["volcengine-plan"],
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
          const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
          const apiKey = auth.apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            providers: Object.fromEntries(
              await Promise.all(
                VOLCENGINE_PROVIDER_CATALOG_ENTRIES.map(
                  async ({ id, buildProvider }) =>
                    [
                      id,
                      await buildOpenAICompatibleLiveModelProviderConfig({
                        providerId: id,
                        providerConfig: buildProvider(),
                        apiKey,
                        discoveryApiKey: auth.discoveryApiKey,
                      }),
                    ] as const,
                ),
              ),
            ),
          };
        },
      },
      staticCatalog: {
        order: "paired",
        run: async () => ({
          providers: Object.fromEntries(
            VOLCENGINE_PROVIDER_CATALOG_ENTRIES.map(({ id, buildProvider }) => [
              id,
              buildProvider(),
            ]),
          ),
        }),
      },
      augmentModelCatalog: () =>
        VOLCENGINE_PROVIDER_CATALOG_ENTRIES.flatMap(({ id: provider, models }) =>
          models.map((entry) => ({
            provider,
            id: entry.id,
            name: entry.name,
            reasoning: entry.reasoning,
            input: [...entry.input],
            contextWindow: entry.contextWindow,
          })),
        ),
      normalizeResolvedModel: ({ model }) => applyVolcengineToolSchemaCompat(model),
    });
    api.registerSpeechProvider(buildVolcengineSpeechProvider());
  },
});
