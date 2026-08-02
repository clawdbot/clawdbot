/**
 * BytePlus provider plugin entrypoint for model and video generation providers.
 */
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { BYTEPLUS_PROVIDER_CATALOG_ENTRIES } from "./provider-catalog.js";
import { buildBytePlusVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "byteplus";
const BYTEPLUS_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "byteplus-plan")!;

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "BytePlus Provider",
  description: "BytePlus provider plugin",
  manifest,
  provider: {
    label: "BytePlus",
    docsPath: "/concepts/model-providers#byteplus-international",
    manifestAuth: {
      defaultModel: BYTEPLUS_DEFAULT_MODEL_REF,
      applyConfig: (cfg) =>
        ensureModelAllowlistEntry({ cfg, modelRef: BYTEPLUS_DEFAULT_MODEL_REF }),
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
              BYTEPLUS_PROVIDER_CATALOG_ENTRIES.map(
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
          BYTEPLUS_PROVIDER_CATALOG_ENTRIES.map(({ id, buildProvider }) => [id, buildProvider()]),
        ),
      }),
    },
    augmentModelCatalog: () =>
      BYTEPLUS_PROVIDER_CATALOG_ENTRIES.flatMap(({ id: provider, models }) =>
        models.map((entry) => ({
          provider,
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: [...entry.input],
          contextWindow: entry.contextWindow,
        })),
      ),
  },
  register(api) {
    api.registerVideoGenerationProvider(buildBytePlusVideoGenerationProvider());
  },
});
