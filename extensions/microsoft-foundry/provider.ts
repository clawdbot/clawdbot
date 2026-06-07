// Microsoft Foundry provider module implements model/runtime integration.
import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/core";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { OPENAI_RESPONSES_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { apiKeyAuthMethod, entraIdAuthMethod } from "./auth.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
  PROVIDER_ID,
  applyFoundryProfileBinding,
  applyFoundryProviderConfig,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  isFoundryProviderApi,
  normalizeFoundryEndpoint,
  resolveFoundryModelCapabilities,
  resolveFoundryTargetProfileId,
} from "./shared.js";

type FoundryProviderHooks = Pick<ProviderPlugin, "wrapStreamFn">;

const wrapOpenAIResponsesStreamFn = OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn;

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
      const selectedModelCapabilities = resolveFoundryModelCapabilities(
        selectedModelId,
        existingModel?.name,
        isFoundryProviderApi(existingModel?.api) ? existingModel.api : providerConfig.api,
        existingModel?.input,
      );
      const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl ?? "");
      // Prefer the persisted per-model API choice from onboarding/discovery so arbitrary
      // deployment aliases (for example prod-primary) do not fall back to name heuristics.
      const selectedModelApi = isFoundryProviderApi(existingModel?.api)
        ? existingModel.api
        : providerConfig.api;
      const nextModels = configuredModels.map((model) => {
        if (model.id !== selectedModelId) {
          return model;
        }
        const nextModel = Object.assign({}, model, {
          name: selectedModelCapabilities.modelName,
          api: selectedModelCapabilities.api,
          reasoning: selectedModelCapabilities.reasoning || model.reasoning,
          thinkingLevelMap: selectedModelCapabilities.thinkingLevelMap ?? model.thinkingLevelMap,
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
          reasoning: selectedModelCapabilities.reasoning,
          ...(selectedModelCapabilities.thinkingLevelMap
            ? { thinkingLevelMap: selectedModelCapabilities.thinkingLevelMap }
            : {}),
          input: selectedModelCapabilities.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
          ...(selectedModelCapabilities.compat ? { compat: selectedModelCapabilities.compat } : {}),
        });
      }
      const nextProviderConfig: ModelProviderConfig = {
        ...providerConfig,
        baseUrl: buildFoundryProviderBaseUrl(
          providerEndpoint,
          selectedModelId,
          selectedModelCapabilities.modelName,
          selectedModelApi,
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
