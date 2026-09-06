import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  cloneFirstTemplateModel,
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isFireworksKimiModelId } from "./model-id.js";
import { applyFireworksConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  isFireworksCatalogModelId,
} from "./provider-catalog.js";
import { wrapFireworksProviderStream } from "./stream.js";
import { resolveFireworksThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "fireworks";

function isFireworksGlmModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^glm[-_.]/.test(lastSegment);
}

function resolveFireworksDynamicInput(modelId: string): Array<"text" | "image"> {
  return isFireworksGlmModelId(modelId) ? ["text"] : ["text", "image"];
}

function resolveFireworksDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId) {
    return undefined;
  }

  if (isFireworksCatalogModelId(modelId)) {
    return undefined;
  }

  const isKimiModel = isFireworksKimiModelId(modelId);
  const input = resolveFireworksDynamicInput(modelId);

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId,
      templateIds: [FIREWORKS_DEFAULT_MODEL_ID],
      ctx,
      patch: {
        provider: PROVIDER_ID,
        reasoning: !isKimiModel,
        input,
      },
    }) ??
    normalizeModelCompat({
      id: modelId,
      name: modelId,
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: FIREWORKS_BASE_URL,
      reasoning: !isKimiModel,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS || DEFAULT_CONTEXT_TOKENS,
    })
  );
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Fireworks Provider",
  description: "Bundled Fireworks AI provider plugin",
  manifest,
  provider: {
    label: "Fireworks",
    aliases: ["fireworks-ai"],
    docsPath: "/providers/fireworks",
    manifestAuth: { applyConfig: applyFireworksConfig },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    wrapStreamFn: wrapFireworksProviderStream,
    resolveThinkingProfile: ({ modelId }) => resolveFireworksThinkingProfile(modelId),
    resolveDynamicModel: (ctx) => resolveFireworksDynamicModel(ctx),
    isModernModelRef: () => true,
  },
});
