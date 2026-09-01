// Opencode plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";
import { createOpenAICompatibleCompletionsThinkingOffWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyOpencodeZenProviderConfig, OPENCODE_ZEN_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeZenLiveProviderConfig,
  buildStaticOpencodeZenProviderConfig,
  listOpencodeZenModelCatalogEntries,
  normalizeOpencodeZenBaseUrl,
  prepareOpencodeZenModel,
  resolveOpencodeZenModel,
  resolveOpencodeZenStarterModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile as resolveOpencodeThinkingProfile } from "./provider-policy-api.js";
import { registerOpenCodeSessionCatalog } from "./session-catalog-plugin.js";
import { wrapOpencodeProviderStream } from "./stream.js";

const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;
type OpencodeZenCatalogAuth = { apiKey?: string; discoveryApiKey?: string };

function resolveOpencodeZenCatalogAuth(
  resolveProviderApiKey: (providerId: string) => OpencodeZenCatalogAuth,
): OpencodeZenCatalogAuth | undefined {
  const own = resolveProviderApiKey(PROVIDER_ID);
  if (own.apiKey || own.discoveryApiKey) {
    return own;
  }
  const shared = resolveProviderApiKey("opencode-go");
  return shared.apiKey || shared.discoveryApiKey ? shared : undefined;
}

function isModernOpencodeModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Zen Provider",
  description: "OpenCode Zen provider plugin",
  manifest,
  provider: {
    label: "OpenCode Zen",
    docsPath: "/providers/models",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    manifestAuth: {
      hint: "Shared API key infrastructure for Zen + Go",
      promptMessage: "Enter OpenCode API key",
      profileIds: ["opencode:default", "opencode-go:default"],
      defaultModel: OPENCODE_ZEN_DEFAULT_MODEL_REF,
      resolveDefaultModel: async ({ apiKey, signal }) =>
        await resolveOpencodeZenStarterModel({
          apiKey,
          preferredModelRef: OPENCODE_ZEN_DEFAULT_MODEL_REF,
          ...(signal ? { signal } : {}),
        }),
      expectedProviders: ["opencode", "opencode-go"],
      applyConfig: applyOpencodeZenProviderConfig,
      noteMessage: [
        "One OpenCode API key can authenticate Zen and a separately subscribed Go catalog.",
        "Zen provides access to Claude, GPT, Gemini, and more models.",
        "Get your API key at: https://opencode.ai/auth",
        "Choose the Zen catalog when you want the curated multi-model proxy.",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({
        api: providerConfig.api,
        baseUrl: providerConfig.baseUrl,
      });
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeResolvedModel: ({ model }) => {
      const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({
        api: model.api,
        baseUrl: model.baseUrl,
      });
      return normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl
        ? { ...model, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeTransport: ({ api: apiLocal, baseUrl }) => {
      const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({ api: apiLocal, baseUrl });
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api: apiLocal,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    resolveDynamicModel: ({ modelId }) => resolveOpencodeZenModel(modelId),
    prepareDynamicModel: async (ctx) => {
      const profileProvider = ctx.authProfileId
        ? ctx.config?.auth?.profiles?.[ctx.authProfileId]?.provider
        : undefined;
      const ownsProfile = Boolean(
        ctx.authProfileId &&
        (ctx.authProfileId.startsWith("opencode:") ||
          ctx.authProfileId.startsWith("opencode-go:") ||
          profileProvider === "opencode" ||
          profileProvider === "opencode-go"),
      );
      const configured = Boolean(
        ownsProfile ||
        ctx.providerConfig ||
        ctx.config?.models?.providers?.opencode ||
        ctx.config?.models?.providers?.["opencode-go"] ||
        process.env.OPENCODE_API_KEY?.trim() ||
        process.env.OPENCODE_ZEN_API_KEY?.trim(),
      );
      return configured ? await prepareOpencodeZenModel({ modelId: ctx.modelId }) : undefined;
    },
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds !== undefined && !ctx.providerIds.includes(PROVIDER_ID)) {
          return null;
        }
        const auth = resolveOpencodeZenCatalogAuth(ctx.resolveProviderApiKey);
        if (!auth) {
          return null;
        }
        if (!auth.discoveryApiKey) {
          return {
            provider: buildStaticOpencodeZenProviderConfig(auth.apiKey),
          };
        }
        return {
          provider: await buildOpencodeZenLiveProviderConfig({
            apiKey: auth.apiKey ?? auth.discoveryApiKey,
            discoveryApiKey: auth.discoveryApiKey,
          }),
        };
      },
      staticRun: async () => ({ provider: buildStaticOpencodeZenProviderConfig() }),
    },
    augmentModelCatalog: () => listOpencodeZenModelCatalogEntries(),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
    resolveThinkingProfile: resolveOpencodeThinkingProfile,
    wrapStreamFn: (ctx) => {
      if (!ctx.streamFn) {
        return undefined;
      }
      const baseStreamFn = ctx.streamFn;
      const thinkingOff = createOpenAICompatibleCompletionsThinkingOffWrapper(
        baseStreamFn,
        ctx.thinkingLevel,
      );
      const thinkingStreamFn: typeof baseStreamFn = (model, context, options) =>
        model.provider === PROVIDER_ID && model.id === "kimi-k3"
          ? thinkingOff(model, context, options)
          : baseStreamFn(model, context, options);
      return wrapOpencodeProviderStream({ ...ctx, streamFn: thinkingStreamFn });
    },
  },
  register(api) {
    api.registerMediaUnderstandingProvider(opencodeMediaUnderstandingProvider);
    registerOpenCodeSessionCatalog(api);
  },
});
