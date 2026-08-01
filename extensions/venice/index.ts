// Venice plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  applyModelCompatPatch,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { VENICE_MODEL_DISCOVERY_OPTIONS } from "./models.js";
import { applyVeniceConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildStaticVeniceProvider } from "./provider-catalog.js";
import { createVeniceDeepSeekV4Wrapper } from "./stream.js";
import { fetchVeniceUsage } from "./usage.js";

const PROVIDER_ID = "venice";
const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
] as const;

function applyXaiModelCompat<T extends { compat?: unknown }>(model: T): T {
  return applyModelCompatPatch(model as T & { compat?: ModelCompatConfig }, {
    toolSchemaProfile: "xai",
    unsupportedToolSchemaKeywords: [...XAI_UNSUPPORTED_SCHEMA_KEYWORDS],
    toolCallArgumentsEncoding: "html-entities",
  }) as T;
}

function isXaiBackedVeniceModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("grok");
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Venice Provider",
  description: "Bundled Venice provider plugin",
  manifest,
  provider: {
    label: "Venice",
    docsPath: "/providers/venice",
    manifestAuth: {
      applyConfig: applyVeniceConfig,
      noteMessage: [
        "Venice AI provides privacy-focused inference with uncensored models.",
        "Get your API key at: https://venice.ai/settings/api",
        "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
      ].join("\n"),
      noteTitle: "Venice AI",
    },
    catalog: {
      buildProvider: buildStaticVeniceProvider,
      liveModelDiscovery: VENICE_MODEL_DISCOVERY_OPTIONS,
    },
    normalizeResolvedModel: ({ modelId, model }) =>
      isXaiBackedVeniceModel(modelId) ? applyXaiModelCompat(model) : undefined,
    wrapStreamFn: (ctx) => createVeniceDeepSeekV4Wrapper(ctx.streamFn, ctx.thinkingLevel),
    resolveUsageAuth: async (ctx) => {
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        envDirect: [ctx.env.VENICE_API_KEY],
      });
      return apiKey ? { token: apiKey } : null;
    },
    fetchUsageSnapshot: async (ctx) =>
      await fetchVeniceUsage({
        token: ctx.token,
        timeoutMs: ctx.timeoutMs,
        fetchFn: ctx.fetchFn,
      }),
  },
});
