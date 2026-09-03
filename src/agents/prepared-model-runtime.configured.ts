import {
  collectConfiguredModelRefs,
  type ConfiguredModelRef,
} from "@openclaw/model-catalog-core/configured-model-refs";
import {
  buildModelCatalogMergeKey,
  parseModelCatalogRef,
  type ModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { MODEL_APIS } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  normalizePluginDiscoveryResult,
  type PreparedProviderStaticCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import type { StaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import { resolveConfiguredModelHarnessRuntime } from "./harness-runtimes.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";
import { resolveEffectiveAgentRuntime } from "./thinking-runtime.js";

export type PreparedConfiguredRuntimeModel = Readonly<{
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
}>;

/**
 * A concrete runtime contract attached to the logical provider/model ref that
 * selects it. Prepared catalog rows retain this fact after runtime-only rows
 * are intentionally omitted from the configured view.
 */
export type PreparedRuntimeCapabilityModel = PreparedConfiguredRuntimeModel;

/** Collects defaults, global refs, and only the selected agent's overrides. */
export function collectPreparedModelRuntimeConfiguredRefs(
  config: OpenClawConfig,
  agentId: string | undefined,
): ConfiguredModelRef[] {
  if (!agentId) {
    return collectConfiguredModelRefs(config);
  }
  const entry = resolveAgentEntry(config, agentId);
  return collectConfiguredModelRefs({
    ...config,
    agents: {
      ...(config.agents?.defaults ? { defaults: config.agents.defaults } : {}),
      list: entry ? [entry] : [],
    },
  });
}

function isCatalogModelApi(
  value: string | undefined,
): value is NonNullable<ModelCatalogEntry["api"]> {
  return value !== undefined && (MODEL_APIS as readonly string[]).includes(value);
}

export function toStaticCatalogEntry(model: ProviderRuntimeModel): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: model.provider,
    ...(isCatalogModelApi(model.api) ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.contextWindows
      ? {
          contextWindows: model.contextWindows.map((option) => ({ ...option })),
        }
      : {}),
    ...(model.contextWindowDefault ? { contextWindowDefault: model.contextWindowDefault } : {}),
    ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.input ? { input: model.input } : {}),
    ...(model.params ? { params: model.params } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.mediaInput ? { mediaInput: model.mediaInput } : {}),
  };
}

export function collectPreparedModelRuntimeProviderIds(
  config: OpenClawConfig,
  credentials: Readonly<AuthStorageData>,
  includeCredentialProviders: boolean,
  configuredModelRefs: readonly ConfiguredModelRef[] = collectConfiguredModelRefs(config),
  agentId?: string,
): string[] {
  const providerIds = new Set<string>();
  const addProviderId = (value: string) => {
    const providerId = normalizeProviderId(value);
    if (providerId) {
      providerIds.add(providerId);
    }
  };
  if (includeCredentialProviders) {
    for (const providerId of Object.keys(credentials)) {
      addProviderId(providerId);
    }
  }
  for (const ref of configuredModelRefs) {
    const separator = ref.value.indexOf("/");
    if (separator > 0) {
      addProviderId(ref.value.slice(0, separator));
    }
    addProviderId(
      resolveConfiguredModelHarnessRuntime({
        config,
        modelRef: ref.value,
        agentId,
        includeImplicitRuntimePreferences: false,
      }) ?? "",
    );
  }
  return [...providerIds].toSorted((left, right) => left.localeCompare(right));
}

function hasConfiguredInlineProviderModel(
  config: OpenClawConfig,
  provider: string,
  modelId: string,
  matchesStaticModelId: StaticModelIdMatcher,
): boolean {
  return Object.entries(config.models?.providers ?? {}).some(
    ([providerId, providerConfig]) =>
      normalizeProviderId(providerId) === provider &&
      (providerConfig.models ?? []).some((model) =>
        matchesStaticModelId({
          candidateId: model.id,
          rowProvider: providerId,
          provider,
          modelId,
        }),
      ),
  );
}

export function collectConfiguredProviderIdsNeedingStaticCatalog(params: {
  config: OpenClawConfig;
  configuredModelRefs?: readonly ConfiguredModelRef[];
  resolveStaticCatalogModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
  matchesStaticModelId: StaticModelIdMatcher;
}): string[] {
  const providerIds = new Set<string>();
  for (const { value } of params.configuredModelRefs ?? collectConfiguredModelRefs(params.config)) {
    const parsed = parseModelCatalogRef(value);
    if (!parsed) {
      continue;
    }
    const { provider, modelId } = parsed;
    if (
      hasConfiguredInlineProviderModel(
        params.config,
        provider,
        modelId,
        params.matchesStaticModelId,
      ) ||
      params.resolveStaticCatalogModel({ provider, modelId })
    ) {
      continue;
    }
    providerIds.add(provider);
  }
  return [...providerIds].toSorted((left, right) => left.localeCompare(right));
}

export function prepareConfiguredRuntimeModels(params: {
  configuredModelRefs: readonly ModelCatalogRef[];
  metadataSnapshot: PluginMetadataSnapshot;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerStaticModels: readonly ProviderRuntimeModel[];
  resolveStaticCatalogModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
  matchesStaticModelId: StaticModelIdMatcher;
}): PreparedConfiguredRuntimeModel[] {
  const prepared: PreparedConfiguredRuntimeModel[] = [];
  const seen = new Set<string>();
  for (const { modelId, provider } of params.configuredModelRefs) {
    const key = buildModelCatalogMergeKey(provider, modelId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Match request-time fallback precedence exactly: manifest/runtime-discovery rows win,
    // and the provider-static catalog fills only models absent from that surface.
    const model =
      params.resolveStaticCatalogModel({ provider, modelId }) ??
      findPreparedProviderStaticCatalogModel({
        prepared: params.preparedStaticProviderCatalog,
        metadataSnapshot: params.metadataSnapshot,
        provider,
        modelId,
        matchesStaticModelId: params.matchesStaticModelId,
      }) ??
      params.providerStaticModels.find((candidate) =>
        params.matchesStaticModelId({
          candidateId: candidate.id,
          rowProvider: candidate.provider,
          provider,
          modelId,
        }),
      );
    if (model) {
      prepared.push({ provider, modelId, model });
    }
  }
  return prepared;
}

/** Resolve concrete runtime capabilities once while materializing agent facts. */
export function prepareRuntimeCapabilityModels(params: {
  config: OpenClawConfig;
  agentId?: string;
  candidates: readonly ModelCatalogEntry[];
  resolveRuntimeModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
}): PreparedRuntimeCapabilityModel[] {
  const prepared: PreparedRuntimeCapabilityModel[] = [];
  const seen = new Set<string>();
  for (const candidate of params.candidates) {
    const provider = normalizeProviderId(candidate.provider);
    const modelId = candidate.id.trim();
    if (!provider || !modelId) {
      continue;
    }
    const runtime = resolveEffectiveAgentRuntime({
      cfg: params.config,
      provider,
      modelId,
      modelApi: candidate.api,
      modelBaseUrl: candidate.baseUrl,
      agentId: params.agentId,
    });
    if (runtime === provider || runtime === "openclaw") {
      continue;
    }
    const key = buildModelCatalogMergeKey(provider, modelId);
    if (seen.has(key)) {
      continue;
    }
    const model = params.resolveRuntimeModel({ provider: runtime, modelId });
    if (!model) {
      continue;
    }
    seen.add(key);
    prepared.push({ provider, modelId, model });
  }
  return prepared;
}

function findPreparedProviderStaticCatalogModel(params: {
  prepared: PreparedProviderStaticCatalog | undefined;
  metadataSnapshot: PluginMetadataSnapshot;
  provider: string;
  modelId: string;
  matchesStaticModelId: StaticModelIdMatcher;
}): ProviderRuntimeModel | undefined {
  if (!params.prepared) {
    return undefined;
  }
  for (const { provider, result } of params.prepared.entries) {
    for (const [providerId, providerConfig] of Object.entries(
      normalizePluginDiscoveryResult({ provider, result }),
    )) {
      const model = (providerConfig.models ?? []).find((candidate) =>
        params.matchesStaticModelId({
          candidateId: candidate.id,
          rowProvider: providerId,
          provider: params.provider,
          modelId: params.modelId,
        }),
      );
      if (!model) {
        continue;
      }
      const [resolved] = buildInlineProviderModels(
        { [providerId]: { ...providerConfig, models: [model] } },
        { providerMetadataOwners: params.metadataSnapshot.owners },
      );
      if (resolved) {
        return resolved as ProviderRuntimeModel;
      }
    }
  }
  return undefined;
}
