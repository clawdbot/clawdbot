// Volcengine plugin entrypoint registers its OpenClaw integration.
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import { applyVolcengineToolSchemaCompat } from "./api.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { VOLCENGINE_PROVIDER_CATALOG_ENTRIES } from "./provider-catalog.js";
import { buildVolcengineSpeechProvider } from "./speech-provider.js";

const PROVIDER_ID = "volcengine";
const VOLCENGINE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "volcengine-plan",
)!;

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Volcengine Provider",
  description: "Bundled Volcengine provider plugin",
  manifest,
  provider: {
    label: "Volcengine",
    docsPath: "/concepts/model-providers#volcano-engine-doubao",
    hookAliases: ["volcengine-plan"],
    manifestAuth: {
      defaultModel: VOLCENGINE_DEFAULT_MODEL_REF,
      applyConfig: (cfg) =>
        ensureModelAllowlistEntry({ cfg, modelRef: VOLCENGINE_DEFAULT_MODEL_REF }),
    },
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
      staticRun: async () => ({
        providers: Object.fromEntries(
          VOLCENGINE_PROVIDER_CATALOG_ENTRIES.map(({ id, buildProvider }) => [id, buildProvider()]),
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
  },
  register(api) {
    api.registerSpeechProvider(buildVolcengineSpeechProvider());
  },
});
