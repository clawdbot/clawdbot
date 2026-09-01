import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Model } from "../../llm/types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
} from "../../plugins/provider-runtime.js";
import { canonicalizeOpenAIModelId } from "../openai-routing.js";
import { inheritModelProviderRequestRouteFacts } from "../provider-request-config.js";
import {
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
} from "./model.inline-provider.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";

export type ProviderRuntimeHooks = {
  applyProviderResolvedTransportWithPlugin?: (
    params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0],
  ) => unknown;
  buildProviderUnknownModelHintWithPlugin: (
    params: Parameters<typeof buildProviderUnknownModelHintWithPlugin>[0],
  ) => string | undefined;
  prepareProviderDynamicModel: (
    params: Parameters<typeof prepareProviderDynamicModel>[0],
  ) => ReturnType<typeof prepareProviderDynamicModel>;
  runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
  shouldPreferProviderRuntimeResolvedModel?: (
    params: Parameters<typeof shouldPreferProviderRuntimeResolvedModel>[0],
  ) => boolean;
  normalizeProviderResolvedModelWithPlugin: (
    params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0],
  ) => unknown;
  normalizeProviderTransportWithPlugin: typeof normalizeProviderTransportWithPlugin;
};

const TARGET_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  buildProviderUnknownModelHintWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
  normalizeProviderResolvedModelWithPlugin,
  // Target-provider resolution keeps owner hooks, but avoids broad
  // cross-provider hooks that can load unrelated bundled provider runtimes.
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

export const DEFAULT_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  ...TARGET_PROVIDER_RUNTIME_HOOKS,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderTransportWithPlugin,
};

const STATIC_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

const SKIP_AGENT_DISCOVERY_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  // skipAgentDiscovery is the lean path used before agent discovery/models.json has run.
  ...TARGET_PROVIDER_RUNTIME_HOOKS,
};

export function resolveRuntimeHooks(params?: {
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
  skipAgentDiscovery?: boolean;
}): ProviderRuntimeHooks {
  if (params?.skipProviderRuntimeHooks) {
    return STATIC_PROVIDER_RUNTIME_HOOKS;
  }
  if (params?.runtimeHooks) {
    return params.runtimeHooks;
  }
  if (params?.skipAgentDiscovery) {
    return SKIP_AGENT_DISCOVERY_PROVIDER_RUNTIME_HOOKS;
  }
  return DEFAULT_PROVIDER_RUNTIME_HOOKS;
}

function canonicalizeLegacyResolvedModel(params: { provider: string; model: Model }): Model {
  const canonicalModelId = canonicalizeOpenAIModelId(params.provider, params.model.id);
  if (canonicalModelId === params.model.id) {
    return params.model;
  }
  return {
    ...params.model,
    id: canonicalModelId,
    name:
      canonicalizeOpenAIModelId(params.provider, params.model.name) === canonicalModelId
        ? canonicalModelId
        : params.model.name,
  };
}

function applyResolvedTransportFallback(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
  model: Model;
}): Model | undefined {
  const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.model.id,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: params.model.id,
      api: params.model.api,
      baseUrl: params.model.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;
  if (!normalized) {
    return undefined;
  }
  const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
  if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
    return undefined;
  }
  return {
    ...params.model,
    api: nextApi,
    baseUrl: nextBaseUrl,
  };
}

export function normalizeResolvedModel(params: {
  provider: string;
  model: Model;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model {
  const normalizeModelCost = (cost: unknown): Model["cost"] => {
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const record = cost as Partial<Model["cost"]>;
    const input =
      typeof record.input === "number" && Number.isFinite(record.input) ? record.input : 0;
    const output =
      typeof record.output === "number" && Number.isFinite(record.output) ? record.output : 0;
    const cacheRead =
      typeof record.cacheRead === "number" && Number.isFinite(record.cacheRead)
        ? record.cacheRead
        : 0;
    const cacheWrite =
      typeof record.cacheWrite === "number" && Number.isFinite(record.cacheWrite)
        ? record.cacheWrite
        : 0;
    if (
      input === record.input &&
      output === record.output &&
      cacheRead === record.cacheRead &&
      cacheWrite === record.cacheWrite
    ) {
      return record as Model["cost"];
    }
    return { ...cost, input, output, cacheRead, cacheWrite };
  };

  const normalizedInputModel = {
    ...params.model,
    input: resolveProviderModelInput({
      provider: params.provider,
      modelId: params.model.id,
      modelName: params.model.name,
      input: params.model.input,
    }),
    cost: normalizeModelCost((params.model as { cost?: unknown }).cost),
  } as Model & ProviderRuntimeModel;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: normalizedInputModel,
    },
  }) as Model | undefined;
  const transportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: (pluginNormalized ?? normalizedInputModel) as never,
    },
  }) as Model | undefined;
  const fallbackTransportNormalized =
    transportNormalized ??
    applyResolvedTransportFallback({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      runtimeHooks,
      model: pluginNormalized ?? normalizedInputModel,
    });
  const normalizedModel = normalizeResolvedProviderModel({
    provider: params.provider,
    model: fallbackTransportNormalized ?? pluginNormalized ?? normalizedInputModel,
  }) as Model & ProviderRuntimeModel;
  // Rebuilding provider hooks may drop the host-prepared timeout. Restore it
  // only when the final model does not declare a provider-owned override.
  const modelWithProviderTimeout =
    normalizedModel.requestTimeoutMs === undefined &&
    normalizedInputModel.requestTimeoutMs !== undefined
      ? { ...normalizedModel, requestTimeoutMs: normalizedInputModel.requestTimeoutMs }
      : normalizedModel;
  return inheritModelProviderRequestRouteFacts(
    params.model,
    canonicalizeLegacyResolvedModel({
      provider: params.provider,
      model: modelWithProviderTimeout,
    }),
  );
}

export function resolveProviderTransport(params: {
  provider: string;
  modelId?: string;
  api?: Api | null;
  baseUrl?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): { api?: Api; baseUrl?: string } {
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const normalized = runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    ...(params.modelId ? { modelId: params.modelId } : {}),
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      ...(params.modelId ? { modelId: params.modelId } : {}),
      api: params.api,
      baseUrl: params.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;
  return {
    api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
    baseUrl: normalized?.baseUrl ?? params.baseUrl,
  };
}

export function normalizeTransportBaseUrl(baseUrl: unknown): string | undefined {
  return normalizeOptionalString(baseUrl);
}

export function resolveProviderRequestTimeoutMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true });
}
