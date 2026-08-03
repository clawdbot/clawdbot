// Microsoft Foundry provider module implements model/runtime integration.
import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/core";
import {
  resolveClaudeThinkingProfile,
  supportsClaudeNativeMaxEffort,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { apiKeyAuthMethod, entraIdAuthMethod } from "./auth.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
  PROVIDER_ID,
  applyFoundryProfileBinding,
  applyFoundryProviderConfig,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  isFoundryClaudeMythosPreview,
  isFoundryProviderApi,
  mergeFoundryCanonicalModelParams,
  normalizeFoundryEndpoint,
  resolveFoundryModelCapabilities,
  resolveFoundryTargetProfileId,
} from "./shared.js";

type FoundryProviderHooks = Pick<ProviderPlugin, "wrapStreamFn">;

const openAIResponsesStreamHooks = buildProviderStreamFamilyHooks("openai-responses-defaults");
const wrapOpenAIResponsesStreamFn = openAIResponsesStreamHooks.wrapStreamFn;

const wrapMicrosoftFoundryStreamFn: NonNullable<FoundryProviderHooks["wrapStreamFn"]> = (ctx) => {
  if (ctx.model?.api !== "openai-responses") {
    return ctx.streamFn ?? null;
  }

  const baseStreamFn = ctx.streamFn;
  if (!baseStreamFn) {
    return wrapOpenAIResponsesStreamFn?.(ctx) ?? null;
  }

  const streamFnWithResponsesReplayIds: NonNullable<typeof ctx.streamFn> = (
    model,
    context,
    options,
  ) =>
    baseStreamFn(model, context, {
      ...options,
      // Foundry validates encrypted reasoning replay against the original item id,
      // even though its Responses endpoint does not support persisted `store`.
      replayResponsesItemIds: true,
    } as typeof options & { replayResponsesItemIds: true });

  return (
    wrapOpenAIResponsesStreamFn?.({
      ...ctx,
      streamFn: streamFnWithResponsesReplayIds,
    }) ?? streamFnWithResponsesReplayIds
  );
};

export function buildMicrosoftFoundryProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Microsoft Foundry",
    docsPath: "/providers/models",
    envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
    auth: [entraIdAuthMethod, apiKeyAuthMethod],
    onModelSelected: async (ctx) => {
      const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
      if (
        !providerConfig ||
        !providerConfig.baseUrl?.trim() ||
        !Array.isArray(providerConfig.models) ||
        !ctx.model.startsWith(`${PROVIDER_ID}/`)
      ) {
        return;
      }
      const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
      const configuredModels = providerConfig.models ?? [];
      const existingModel = configuredModels.find(
        (model: { id: string }) => model.id === selectedModelId,
      );
      const existingModelApi = isFoundryProviderApi(existingModel?.api)
        ? existingModel.api
        : undefined;
      const providerApiForExistingModel =
        existingModel && isFoundryProviderApi(providerConfig.api) ? providerConfig.api : undefined;
      const selectedModelCapabilities = resolveFoundryModelCapabilities(
        selectedModelId,
        existingModel?.name,
        existingModelApi ?? providerApiForExistingModel,
        existingModel?.input,
      );
      const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl ?? "");
      const selectedProviderEndpoint =
        extractFoundryEndpoint(existingModel?.baseUrl) ?? providerEndpoint;
      const nextModels = configuredModels.map((model) => {
        if (model.id !== selectedModelId) {
          return model;
        }
        const selectedModelEndpoint = extractFoundryEndpoint(model.baseUrl) ?? providerEndpoint;
        const selectedModelBaseUrl = buildFoundryProviderBaseUrl(
          selectedModelEndpoint,
          selectedModelId,
          selectedModelCapabilities.modelName,
          selectedModelCapabilities.api,
        );
        const nextModel = Object.assign({}, model, {
          name: selectedModelCapabilities.modelName,
          api: selectedModelCapabilities.api,
          baseUrl: selectedModelBaseUrl,
          reasoning: selectedModelCapabilities.reasoning || model.reasoning,
          thinkingLevelMap: selectedModelCapabilities.thinkingLevelMap ?? model.thinkingLevelMap,
          params: mergeFoundryCanonicalModelParams(
            model.params,
            selectedModelCapabilities.modelName,
          ),
          input: selectedModelCapabilities.input,
        });
        if (selectedModelCapabilities.compat) {
          const explicitSupportsReasoningEffort =
            typeof model.compat?.supportsReasoningEffort === "boolean"
              ? model.compat.supportsReasoningEffort
              : undefined;
          const preserveExplicitReasoningEffort =
            !selectedModelCapabilities.reasoning &&
            model.reasoning &&
            explicitSupportsReasoningEffort !== false;
          const explicitMaxTokensField =
            typeof model.compat?.maxTokensField === "string"
              ? model.compat.maxTokensField
              : preserveExplicitReasoningEffort
                ? "max_completion_tokens"
                : undefined;
          nextModel.compat = {
            ...model.compat,
            ...selectedModelCapabilities.compat,
            ...(explicitSupportsReasoningEffort !== undefined
              ? { supportsReasoningEffort: explicitSupportsReasoningEffort }
              : preserveExplicitReasoningEffort
                ? { supportsReasoningEffort: true }
                : undefined),
            ...(explicitMaxTokensField ? { maxTokensField: explicitMaxTokensField } : {}),
          };
        }
        return nextModel;
      });
      if (!nextModels.some((model) => model.id === selectedModelId)) {
        nextModels.push({
          id: selectedModelId,
          name: selectedModelCapabilities.modelName,
          api: selectedModelCapabilities.api,
          baseUrl: buildFoundryProviderBaseUrl(
            providerEndpoint,
            selectedModelId,
            selectedModelCapabilities.modelName,
            selectedModelCapabilities.api,
          ),
          reasoning: selectedModelCapabilities.reasoning,
          ...(selectedModelCapabilities.thinkingLevelMap
            ? { thinkingLevelMap: selectedModelCapabilities.thinkingLevelMap }
            : {}),
          params: mergeFoundryCanonicalModelParams(undefined, selectedModelCapabilities.modelName),
          input: selectedModelCapabilities.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: selectedModelCapabilities.contextWindow,
          maxTokens: selectedModelCapabilities.maxTokens,
          ...(selectedModelCapabilities.compat ? { compat: selectedModelCapabilities.compat } : {}),
        });
      }
      const nextProviderConfig: ModelProviderConfig = {
        ...providerConfig,
        baseUrl: buildFoundryProviderBaseUrl(
          selectedProviderEndpoint,
          selectedModelId,
          selectedModelCapabilities.modelName,
          selectedModelCapabilities.api,
        ),
        api: selectedModelCapabilities.api,
        models: nextModels,
      };
      const targetProfileId = resolveFoundryTargetProfileId(ctx.config);
      if (targetProfileId) {
        applyFoundryProfileBinding(ctx.config, targetProfileId);
      }
      applyFoundryProviderConfig(ctx.config, nextProviderConfig);
    },
    resolveThinkingProfile: ({ modelId, params }) => {
      const modelName =
        typeof params?.canonicalModelId === "string" ? params.canonicalModelId : undefined;
      const capabilities = resolveFoundryModelCapabilities(modelId, modelName);
      if (!capabilities.reasoning || capabilities.api !== "anthropic-messages") {
        return undefined;
      }
      const profile = resolveClaudeThinkingProfile(capabilities.modelName, undefined, {
        includeNativeMax: supportsClaudeNativeMaxEffort({ id: capabilities.modelName }),
      });
      if (!isFoundryClaudeMythosPreview(capabilities.modelName)) {
        return profile;
      }
      const levels = profile.levels.filter((level) => level.id !== "off");
      return {
        ...profile,
        defaultLevel: "adaptive",
        levels: levels.some((level) => level.id === "adaptive")
          ? levels
          : [...levels, { id: "adaptive" }],
      };
    },
    normalizeResolvedModel: ({ modelId, model }: ProviderNormalizeResolvedModelContext) => {
      const endpoint = extractFoundryEndpoint(model.baseUrl ?? "");
      if (!endpoint) {
        return model;
      }
      const capabilities = resolveFoundryModelCapabilities(
        modelId,
        model.name,
        isFoundryProviderApi(model.api) ? model.api : undefined,
        model.input,
      );
      const explicitSupportsReasoningEffort =
        typeof model.compat?.supportsReasoningEffort === "boolean"
          ? model.compat.supportsReasoningEffort
          : undefined;
      const preserveExplicitReasoningEffort = !capabilities.reasoning && model.reasoning;
      const explicitMaxTokensField =
        typeof model.compat?.maxTokensField === "string"
          ? model.compat.maxTokensField
          : preserveExplicitReasoningEffort
            ? "max_completion_tokens"
            : undefined;
      const compat = capabilities.compat
        ? {
            ...model.compat,
            ...capabilities.compat,
            ...(explicitSupportsReasoningEffort !== undefined
              ? { supportsReasoningEffort: explicitSupportsReasoningEffort }
              : preserveExplicitReasoningEffort
                ? { supportsReasoningEffort: true }
                : undefined),
            ...(explicitMaxTokensField ? { maxTokensField: explicitMaxTokensField } : {}),
          }
        : undefined;
      return {
        ...model,
        name: capabilities.modelName,
        api: capabilities.api,
        reasoning: capabilities.reasoning || model.reasoning,
        thinkingLevelMap: capabilities.thinkingLevelMap ?? model.thinkingLevelMap,
        params: mergeFoundryCanonicalModelParams(model.params, capabilities.modelName),
        input: capabilities.input,
        baseUrl: buildFoundryProviderBaseUrl(
          endpoint,
          modelId,
          capabilities.modelName,
          capabilities.api,
        ),
        ...(compat ? { compat } : {}),
      };
    },
    wrapStreamFn: wrapMicrosoftFoundryStreamFn,
    prepareRuntimeAuth: prepareFoundryRuntimeAuth,
  };
}
