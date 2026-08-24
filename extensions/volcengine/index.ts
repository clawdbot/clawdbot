// Volcengine plugin entrypoint registers its OpenClaw integration.
import { buildOpenAICompatibleProviderFamilyCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import { applyVolcengineToolSchemaCompat } from "./api.js";
import { VOLCENGINE_PROVIDER_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
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
    ...buildOpenAICompatibleProviderFamilyCatalog({
      credentialProviderId: PROVIDER_ID,
      entries: VOLCENGINE_PROVIDER_CATALOG.entries,
      staticCatalog: VOLCENGINE_PROVIDER_CATALOG.staticCatalog,
      augmentModelCatalog: VOLCENGINE_PROVIDER_CATALOG.augmentModelCatalog,
    }),
    normalizeResolvedModel: ({ model }) => applyVolcengineToolSchemaCompat(model),
  },
  register(api) {
    api.registerSpeechProvider(buildVolcengineSpeechProvider());
  },
});
