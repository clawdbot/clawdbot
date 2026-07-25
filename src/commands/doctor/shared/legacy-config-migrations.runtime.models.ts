// Legacy model runtime config migrations for stale model refs, compat fields, and catalog data.
import { isDeepStrictEqual } from "node:util";
import type {
  ModelCatalog,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalAgentRuntimeId } from "../../../agents/agent-runtime-id.js";
import {
  modelTransportRoutesMatch,
  resolveUniqueCatalogModelRoute,
} from "../../../agents/model-compat-catalog.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER,
} from "../../../config/model-policy-allowlist-migration.js";
import { isModelThinkingFormat, type ModelDefinitionConfig } from "../../../config/types.models.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import { planManifestModelCatalogRows } from "../../../model-catalog/manifest-planner.js";
import { listOpenClawPluginManifestMetadata } from "../../../plugins/manifest-metadata-scan.js";
import {
  isLegacyCodexProviderId,
  legacyCodexProviderIdentityKey,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import { isLegacyModelsAddCodexMetadataModel } from "./legacy-models-add-metadata.js";

const STALE_CONTEXT_WINDOW_FIXES: Record<string, { stale: number; correct: number }> = {
  "deepseek/deepseek-v4-flash": { stale: 200_000, correct: 1_000_000 },
  "xai/grok-4.20-0309-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-0309-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-beta-latest-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-beta-latest-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-experimental-beta-0304-reasoning": {
    stale: 2_000_000,
    correct: 1_000_000,
  },
  "xai/grok-4.20-experimental-beta-0304-non-reasoning": {
    stale: 2_000_000,
    correct: 1_000_000,
  },
  "xai/grok-4.20-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
} as const;

const DEAD_MODEL_COMPAT_KEYS = ["nativeWebSearchTool", "requiresMistralToolIds"] as const;

type ModelCompatOverrideState = {
  dead: number;
  divergent: number;
  matching: number;
};

function normalizedCatalogModelKey(provider: string, modelId: string): string {
  // Keep doctor identity aligned with runtime catalog lookup and merge keys,
  // which intentionally treat provider/model ids case-insensitively.
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedId = modelId.trim().toLowerCase();
  const providerPrefix = `${normalizedProvider}/`;
  return `${normalizedProvider}::${normalizedId.startsWith(providerPrefix) ? normalizedId.slice(providerPrefix.length) : normalizedId}`;
}

// Manifest metadata is process-stable; plugin installs/reloads restart the owning process.
const modelCompatCatalogRowsByProvider = new Map<string, readonly NormalizedModelCatalogRow[]>();
let modelCompatCatalogPlugins:
  | Array<{ id: string; modelCatalog: ModelCatalog; providers: string[] }>
  | undefined;

function getModelCompatCatalogPlugins() {
  modelCompatCatalogPlugins ??= listOpenClawPluginManifestMetadata().flatMap(({ manifest }) => {
    const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
    const modelCatalog = getRecord(manifest.modelCatalog);
    if (!id || !modelCatalog) {
      return [];
    }
    return [
      {
        id,
        providers: Array.isArray(manifest.providers)
          ? manifest.providers.filter((value): value is string => typeof value === "string")
          : [],
        modelCatalog: modelCatalog as ModelCatalog,
      },
    ];
  });
  return modelCompatCatalogPlugins;
}

function buildConfiguredProviderCatalogRows(
  providers: Record<string, unknown>,
): Map<string, NormalizedModelCatalogRow[]> {
  const rows = new Map<string, NormalizedModelCatalogRow[]>();
  for (const providerId of Object.keys(providers)) {
    const normalizedProviderId = normalizeProviderId(providerId);
    let providerRows = modelCompatCatalogRowsByProvider.get(normalizedProviderId);
    if (!providerRows) {
      providerRows = planManifestModelCatalogRows({
        registry: { plugins: getModelCompatCatalogPlugins() },
        providerFilter: normalizedProviderId,
      }).rows;
      modelCompatCatalogRowsByProvider.set(normalizedProviderId, providerRows);
    }
    for (const row of providerRows) {
      const key = normalizedCatalogModelKey(row.provider, row.id);
      const variants = rows.get(key) ?? [];
      variants.push(row);
      rows.set(key, variants);
    }
  }
  return rows;
}

function inspectModelCompatOverrides(
  providersValue: unknown,
  onEntry?: (params: {
    catalogRow?: NormalizedModelCatalogRow;
    compat: Record<string, unknown>;
    model: Record<string, unknown>;
    modelIndex: number;
    provider: Record<string, unknown>;
    providerId: string;
    state: ModelCompatOverrideState;
  }) => void,
): ModelCompatOverrideState {
  const providers = getRecord(providersValue);
  const total = { dead: 0, divergent: 0, matching: 0 };
  if (!providers) {
    return total;
  }
  const hasCompat = Object.values(providers).some((providerValue) => {
    const models = getRecord(providerValue)?.models;
    return (
      Array.isArray(models) &&
      models.some((modelValue) => Boolean(getRecord(getRecord(modelValue)?.compat)))
    );
  });
  if (!hasCompat) {
    return total;
  }
  const catalogRows = buildConfiguredProviderCatalogRows(providers);
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    const models = provider?.models;
    if (!provider || !Array.isArray(models)) {
      continue;
    }
    for (const [modelIndex, modelValue] of models.entries()) {
      const model = getRecord(modelValue);
      const compat = getRecord(model?.compat);
      const modelId = typeof model?.id === "string" ? model.id : "";
      if (!model || !compat || !modelId) {
        continue;
      }
      const state = { dead: 0, divergent: 0, matching: 0 };
      for (const key of DEAD_MODEL_COMPAT_KEYS) {
        if (Object.hasOwn(compat, key)) {
          state.dead += 1;
        }
      }
      const configuredRoute = {
        api: model.api ?? provider.api,
        baseUrl: model.baseUrl ?? provider.baseUrl,
      };
      const catalogRow = resolveUniqueCatalogModelRoute(
        catalogRows.get(normalizedCatalogModelKey(providerId, modelId)),
        configuredRoute,
      );
      const catalogRouteMatches = catalogRow !== undefined;
      if (catalogRouteMatches) {
        const catalogCompat = catalogRow.compat ?? {};
        for (const [key, value] of Object.entries(compat)) {
          if ((DEAD_MODEL_COMPAT_KEYS as readonly string[]).includes(key)) {
            continue;
          }
          if (isDeepStrictEqual(value, catalogCompat[key as keyof typeof catalogCompat])) {
            state.matching += 1;
          } else {
            state.divergent += 1;
          }
        }
      }
      total.dead += state.dead;
      total.divergent += state.divergent;
      total.matching += state.matching;
      onEntry?.({ catalogRow, compat, model, modelIndex, provider, providerId, state });
    }
  }
  return total;
}

const MODEL_COMPAT_CATALOG_RULES: LegacyConfigRule[] = [
  {
    path: ["models", "providers"],
    message:
      'nativeWebSearchTool and requiresMistralToolIds are unused and retired; run "openclaw doctor --fix" to remove them.',
    match: (value) => inspectModelCompatOverrides(value).dead > 0,
  },
  {
    path: ["models", "providers"],
    message:
      'Catalog-known model compat values are provider-owned; run "openclaw doctor --fix" to remove matching config overrides.',
    match: (value) => inspectModelCompatOverrides(value).matching > 0,
  },
  {
    path: ["models", "providers"],
    message:
      "Catalog-known model compat differs from the provider catalog and was preserved for review. Use a distinct custom route when the endpoint really has different capabilities.",
    match: (value) => inspectModelCompatOverrides(value).divergent > 0,
  },
];

function migrateModelCompatCatalogOwnership(raw: Record<string, unknown>, changes: string[]): void {
  const providers = getRecord(getRecord(raw.models)?.providers);
  inspectModelCompatOverrides(
    providers,
    ({ catalogRow, compat, model, modelIndex, provider, providerId }) => {
      const removed: string[] = [];
      for (const key of DEAD_MODEL_COMPAT_KEYS) {
        if (Object.hasOwn(compat, key)) {
          delete compat[key];
          removed.push(key);
        }
      }
      if (
        catalogRow &&
        modelTransportRoutesMatch(catalogRow, {
          api: model.api ?? provider.api ?? catalogRow.api,
          baseUrl: model.baseUrl ?? provider.baseUrl ?? catalogRow.baseUrl,
        })
      ) {
        const catalogCompat = catalogRow.compat ?? {};
        for (const [key, value] of Object.entries(compat)) {
          if (isDeepStrictEqual(value, catalogCompat[key as keyof typeof catalogCompat])) {
            delete compat[key];
            removed.push(key);
          }
        }
      }
      if (removed.length === 0) {
        return;
      }
      if (Object.keys(compat).length === 0) {
        delete model.compat;
      }
      changes.push(
        `Removed models.providers.${providerId}.models.${modelIndex}.compat catalog/dead overrides: ${removed.toSorted().join(", ")}.`,
      );
    },
  );
}

function resolveStaleContextWindowFix(params: {
  providerId: string;
  modelId: string;
  contextWindow: number;
}): { stale: number; correct: number } | undefined {
  const providerId = params.providerId.trim().toLowerCase();
  const modelId = params.modelId.trim().toLowerCase();
  const providerPrefix = `${providerId}/`;
  const unprefixedModelId = modelId.startsWith(providerPrefix)
    ? modelId.slice(providerPrefix.length)
    : modelId;
  const scopedModelId = `${providerId}/${unprefixedModelId}`;
  const fix = STALE_CONTEXT_WINDOW_FIXES[scopedModelId];
  return fix && params.contextWindow === fix.stale ? fix : undefined;
}

function hasStaleContextWindowValue(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord) {
    return false;
  }

  for (const [providerId, provider] of Object.entries(providersRecord)) {
    const models = getRecord(provider)?.models;
    if (!Array.isArray(models)) {
      continue;
    }

    for (const model of models) {
      const modelRecord = getRecord(model);
      const modelId = typeof modelRecord?.id === "string" ? modelRecord.id : undefined;
      const contextWindow = modelRecord?.contextWindow;
      if (!modelId || typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
        continue;
      }
      if (resolveStaleContextWindowFix({ providerId, modelId, contextWindow })) {
        return true;
      }
    }
  }

  return false;
}

function hasInvalidThinkingFormat(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord) {
    return false;
  }

  for (const provider of Object.values(providersRecord)) {
    const models = getRecord(provider)?.models;
    if (!Array.isArray(models)) {
      continue;
    }

    for (const model of models) {
      const compat = getRecord(getRecord(model)?.compat);
      const thinkingFormat = compat?.thinkingFormat;
      if (typeof thinkingFormat === "string" && !isModelThinkingFormat(thinkingFormat)) {
        return true;
      }
    }
  }

  return false;
}

const LEGACY_VLLM_QWEN_THINKING_FORMAT_KEYS = [
  "qwenThinkingFormat",
  "qwen_thinking_format",
] as const;

function normalizeLegacyVllmQwenThinkingFormat(
  value: unknown,
): "qwen" | "qwen-chat-template" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  switch (normalized) {
    case "chat-template":
    case "chat-template-argument":
    case "chat-template-arguments":
    case "chat-template-kwarg":
    case "chat-template-kwargs":
    case "qwen-chat-template":
      return "qwen-chat-template";
    case "enable-thinking":
    case "qwen":
    case "request-body":
    case "top-level":
      return "qwen";
    default:
      return undefined;
  }
}

function getLegacyVllmQwenThinkingFormat(params: Record<string, unknown>):
  | {
      key: (typeof LEGACY_VLLM_QWEN_THINKING_FORMAT_KEYS)[number];
      value: unknown;
      compat: "qwen" | "qwen-chat-template" | undefined;
    }
  | undefined {
  for (const key of LEGACY_VLLM_QWEN_THINKING_FORMAT_KEYS) {
    if (Object.hasOwn(params, key)) {
      return {
        key,
        value: params[key],
        compat: normalizeLegacyVllmQwenThinkingFormat(params[key]),
      };
    }
  }
  return undefined;
}

function parseVllmAgentModelKey(key: string): string | undefined {
  const trimmed = splitTrailingAuthProfile(key).model.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  const providerId = trimmed.slice(0, slashIndex);
  if (normalizeProviderId(providerId) !== "vllm") {
    return undefined;
  }
  const modelId = trimmed.slice(slashIndex + 1).trim();
  return modelId && modelId !== "*" ? modelId : undefined;
}

function hasLegacyVllmQwenThinkingFormat(defaultModels: unknown): boolean {
  const models = getRecord(defaultModels);
  if (!models) {
    return false;
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!parseVllmAgentModelKey(key)) {
      continue;
    }
    const params = getRecord(getRecord(entry)?.params);
    if (params && getLegacyVllmQwenThinkingFormat(params)) {
      return true;
    }
  }
  return false;
}

function hasLegacyVllmQwenThinkingProviderParams(provider: unknown): boolean {
  const params = getRecord(getRecord(provider)?.params);
  return Boolean(params && getLegacyVllmQwenThinkingFormat(params));
}

function hasLegacyVllmQwenThinkingModelParams(provider: unknown): boolean {
  const models = getRecord(provider)?.models;
  if (!Array.isArray(models)) {
    return false;
  }
  return models.some((model) => {
    const params = getRecord(getRecord(model)?.params);
    return Boolean(params && getLegacyVllmQwenThinkingFormat(params));
  });
}

function hasLegacyVllmQwenThinkingParams(params: unknown): boolean {
  const record = getRecord(params);
  return Boolean(record && getLegacyVllmQwenThinkingFormat(record));
}

function hasLegacyVllmQwenThinkingAgentParams(agents: unknown): boolean {
  const list = getRecord(agents)?.list;
  if (!Array.isArray(list)) {
    return false;
  }
  return list.some((agent) => hasLegacyVllmQwenThinkingParams(getRecord(agent)?.params));
}

function findOrCreateVllmModelEntry(
  raw: Record<string, unknown>,
  modelId: string,
): { model: Record<string, unknown>; index: number } | undefined {
  const modelsRoot = getOrCreateRecord(raw, "models");
  const providers = modelsRoot ? getOrCreateRecord(modelsRoot, "providers") : undefined;
  const vllm = providers ? getOrCreateVllmProvider(providers) : undefined;
  if (!vllm) {
    return undefined;
  }
  if (vllm.models !== undefined && !Array.isArray(vllm.models)) {
    return undefined;
  }

  const models = Array.isArray(vllm.models) ? vllm.models : [];
  vllm.models = models;
  const providerModelId = `vllm/${modelId}`;
  for (const [index, model] of models.entries()) {
    const record = getRecord(model);
    if (record?.id === modelId || record?.id === providerModelId) {
      return { model: record, index };
    }
  }

  const model = { id: modelId, name: modelId };
  models.push(model);
  return { model, index: models.length - 1 };
}

function listExistingVllmModelTargets(
  raw: Record<string, unknown>,
): Array<{ model: Record<string, unknown>; index: number }> {
  const models = findVllmProvider(getRecord(getRecord(raw.models)?.providers))?.models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models.flatMap((model, index) => {
    const record = getRecord(model);
    return record ? [{ model: record, index }] : [];
  });
}

function collectVllmModelIdsFromSelection(value: unknown): string[] {
  if (typeof value === "string") {
    const modelId = parseVllmAgentModelKey(value);
    return modelId ? [modelId] : [];
  }
  const record = getRecord(value);
  if (!record) {
    return [];
  }
  const ids: string[] = [];
  if (typeof record.primary === "string") {
    const primary = parseVllmAgentModelKey(record.primary);
    if (primary) {
      ids.push(primary);
    }
  }
  if (Array.isArray(record.fallbacks)) {
    for (const fallback of record.fallbacks) {
      if (typeof fallback !== "string") {
        continue;
      }
      const modelId = parseVllmAgentModelKey(fallback);
      if (modelId) {
        ids.push(modelId);
      }
    }
  }
  return ids;
}

function collectVllmModelIdsFromAgentModelMap(value: unknown): string[] {
  const models = getRecord(value);
  if (!models) {
    return [];
  }
  return Object.keys(models).flatMap((key) => {
    const modelId = parseVllmAgentModelKey(key);
    return modelId ? [modelId] : [];
  });
}

function createVllmModelTargets(
  raw: Record<string, unknown>,
  modelIds: string[],
): Array<{ model: Record<string, unknown>; index: number }> {
  const targets: Array<{ model: Record<string, unknown>; index: number }> = [];
  const seen = new Set<Record<string, unknown>>();
  for (const modelId of modelIds) {
    const target = findOrCreateVllmModelEntry(raw, modelId);
    if (!target || seen.has(target.model)) {
      continue;
    }
    seen.add(target.model);
    targets.push(target);
  }
  return targets;
}

function combineVllmModelTargets(
  ...groups: Array<Array<{ model: Record<string, unknown>; index: number }>>
): Array<{ model: Record<string, unknown>; index: number }> {
  const targets: Array<{ model: Record<string, unknown>; index: number }> = [];
  const seen = new Set<Record<string, unknown>>();
  for (const group of groups) {
    for (const target of group) {
      if (seen.has(target.model)) {
        continue;
      }
      seen.add(target.model);
      targets.push(target);
    }
  }
  return targets;
}

function collectVllmModelIdsFromAgentList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((agent) => {
    const record = getRecord(agent);
    return record
      ? [
          ...collectVllmModelIdsFromSelection(record.model),
          ...collectVllmModelIdsFromAgentModelMap(record.models),
        ]
      : [];
  });
}

function getOrCreateRecord(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (root[key] === undefined) {
    const next: Record<string, unknown> = {};
    root[key] = next;
    return next;
  }
  return getRecord(root[key]) ?? undefined;
}

function findVllmProvider(
  providers: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!providers) {
    return undefined;
  }
  const key = Object.keys(providers).find((entry) => normalizeProviderId(entry) === "vllm");
  return key ? (getRecord(providers[key]) ?? undefined) : undefined;
}

function getOrCreateVllmProvider(
  providers: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const key = Object.keys(providers).find((entry) => normalizeProviderId(entry) === "vllm");
  if (key) {
    return getRecord(providers[key]) ?? undefined;
  }
  return getOrCreateRecord(providers, "vllm");
}

function hasLegacyVllmQwenThinkingNormalizedProvider(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord || getRecord(providersRecord.vllm)) {
    return false;
  }
  const vllmProvider = findVllmProvider(providersRecord);
  return (
    hasLegacyVllmQwenThinkingProviderParams(vllmProvider) ||
    hasLegacyVllmQwenThinkingModelParams(vllmProvider)
  );
}

function preserveMigratedVllmQwenReasoning(model: Record<string, unknown>): void {
  if (model.reasoning === undefined) {
    model.reasoning = true;
  }
}

function removeLegacyVllmQwenThinkingParams(params: Record<string, unknown>): void {
  for (const key of LEGACY_VLLM_QWEN_THINKING_FORMAT_KEYS) {
    delete params[key];
  }
}

function applyLegacyVllmQwenThinkingFormat(params: {
  sourcePath: string;
  legacyParams: Record<string, unknown>;
  target: { model: Record<string, unknown>; index: number };
  legacyFormat: NonNullable<ReturnType<typeof getLegacyVllmQwenThinkingFormat>>;
  changes: string[];
}): boolean {
  if (!params.legacyFormat.compat) {
    removeLegacyVllmQwenThinkingParams(params.legacyParams);
    params.changes.push(
      `Removed ${params.sourcePath}.${params.legacyFormat.key} (unrecognized value ${JSON.stringify(params.legacyFormat.value)}; configure models.providers.vllm.models[].compat.thinkingFormat if needed).`,
    );
    return true;
  }

  preserveMigratedVllmQwenReasoning(params.target.model);
  const compat = ensureRecord(params.target.model, "compat");
  const currentThinkingFormat = compat.thinkingFormat;
  if (typeof currentThinkingFormat === "string" && isModelThinkingFormat(currentThinkingFormat)) {
    removeLegacyVllmQwenThinkingParams(params.legacyParams);
    params.changes.push(
      `Removed ${params.sourcePath}.${params.legacyFormat.key}; models.providers.vllm.models[${params.target.index}].compat.thinkingFormat is already ${JSON.stringify(currentThinkingFormat)}.`,
    );
    return true;
  }

  compat.thinkingFormat = params.legacyFormat.compat;
  removeLegacyVllmQwenThinkingParams(params.legacyParams);
  params.changes.push(
    `Moved ${params.sourcePath}.${params.legacyFormat.key} to models.providers.vllm.models[${params.target.index}].compat.thinkingFormat (${JSON.stringify(params.legacyFormat.compat)}).`,
  );
  return true;
}

function removeUntargetedLegacyVllmQwenThinkingFormat(params: {
  sourcePath: string;
  legacyParams: Record<string, unknown>;
  legacyFormat: NonNullable<ReturnType<typeof getLegacyVllmQwenThinkingFormat>>;
  changes: string[];
}): void {
  removeLegacyVllmQwenThinkingParams(params.legacyParams);
  params.changes.push(
    `Removed ${params.sourcePath}.${params.legacyFormat.key}; no concrete vLLM model row or agent model ref exists, so configure models.providers.vllm.models[].compat.thinkingFormat on each Qwen model that needs it.`,
  );
}

const LEGACY_VLLM_QWEN_AGENT_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["agents", "defaults", "models"],
  message:
    'agents.defaults.models.<vllm-model>.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingFormat(value),
};

const LEGACY_VLLM_QWEN_PROVIDER_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers", "vllm", "params"],
  message:
    'models.providers.vllm.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingProviderParams({ params: value }),
};

const LEGACY_VLLM_QWEN_PROVIDER_MODEL_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers", "vllm", "models"],
  message:
    'models.providers.vllm.models[*].params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingModelParams({ models: value }),
};

const LEGACY_VLLM_QWEN_NORMALIZED_PROVIDER_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<vllm>.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.<vllm>.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingNormalizedProvider(value),
};

const LEGACY_VLLM_QWEN_DEFAULT_PARAMS_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["agents", "defaults", "params"],
  message:
    'agents.defaults.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingParams(value),
};

const LEGACY_VLLM_QWEN_AGENT_PARAMS_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["agents"],
  message:
    'agents.list[].params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingAgentParams(value),
};

const INVALID_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].compat.thinkingFormat has an unrecognized value; run "openclaw doctor --fix" to remove it and restore the runtime default.',
  match: (value) => hasInvalidThinkingFormat(value),
};

const STALE_CONTEXT_WINDOW_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].contextWindow has a stale catalog value; run "openclaw doctor --fix" to repair it.',
  match: (value) => hasStaleContextWindowValue(value),
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function preferredClaudeSeparator(provider: string | undefined): "." | "-" {
  return provider === "github-copilot" || provider === "copilot-proxy" ? "." : "-";
}

function claudeTargetModelId(
  family: "opus" | "sonnet",
  separator: "." | "-",
  provider?: string,
): string {
  const version =
    family === "opus" && provider !== "venice" && provider !== "vercel-ai-gateway" ? "4.7" : "4.6";
  return `claude-${family}-${separator === "." ? version : version.replace(".", "-")}`;
}

function shouldUpgradeClaudeProvider(provider: string | undefined): boolean {
  return (
    !provider ||
    provider === "anthropic" ||
    provider === "github-copilot" ||
    provider === "copilot-proxy" ||
    provider === "venice" ||
    provider === "vercel-ai-gateway"
  );
}

function upgradeRetiredGroqModelId(model: string): string | null {
  const normalized = normalizeString(model);
  switch (normalized) {
    case "deepseek-r1-distill-llama-70b":
      return "llama-3.3-70b-versatile";
    case "gemma2-9b-it":
    case "llama3-8b-8192":
      return "llama-3.1-8b-instant";
    case "llama3-70b-8192":
      return "llama-3.3-70b-versatile";
    case "meta-llama/llama-4-maverick-17b-128e-instruct":
    case "moonshotai/kimi-k2-instruct":
    case "moonshotai/kimi-k2-instruct-0905":
      return "openai/gpt-oss-120b";
    case "mistral-saba-24b":
    case "qwen-qwq-32b":
      return "qwen/qwen3-32b";
    default:
      return null;
  }
}

function upgradeRetiredXaiModelId(model: string): string | null {
  const normalized = normalizeString(model);
  switch (normalized) {
    case "grok-code-fast":
    case "grok-code-fast-1":
    case "grok-code-fast-1-0825":
      return "grok-build-0.1";
    case "grok-4-fast-reasoning":
    case "grok-4-1-fast-reasoning":
    case "grok-4-0709":
      return "grok-4.3";
    case "grok-imagine-image-pro":
      return "grok-imagine-image-quality";
    default:
      return null;
  }
}

function upgradeRetiredOpenAiModelId(model: string, provider?: string): string | null {
  const normalized = normalizeString(model);
  const codexProvider = provider === "openai-codex";
  if (codexProvider && normalized === "gpt-5.2") {
    return "gpt-5.5";
  }
  if (
    normalized === "gpt-5.2-codex" ||
    normalized === "gpt-5.1-codex" ||
    normalized === "gpt-5-codex"
  ) {
    return codexProvider ? "gpt-5.5" : "gpt-5.3-codex";
  }
  if (normalized === "gpt-5-pro" || normalized === "gpt-5.2-pro") {
    return "gpt-5.5-pro";
  }
  if (normalized === "gpt-4.1-nano" || normalized === "gpt-5-nano") {
    if (codexProvider) {
      return "gpt-5.4-mini";
    }
    return "gpt-5.4-nano";
  }
  if (
    normalized === "gpt-4.1-mini" ||
    normalized === "gpt-4o-mini" ||
    normalized === "gpt-5.1-codex-mini" ||
    normalized === "gpt-5-mini"
  ) {
    return "gpt-5.4-mini";
  }
  if (
    normalized === "gpt-4" ||
    normalized === "gpt-4-turbo" ||
    normalized === "gpt-4.1" ||
    normalized === "gpt-4o" ||
    normalized === "gpt-4o-2024-05-13" ||
    normalized === "gpt-4o-2024-08-06" ||
    normalized === "gpt-4o-2024-11-20" ||
    normalized === "gpt-5" ||
    normalized === "gpt-5-chat-latest" ||
    normalized === "gpt-5.1" ||
    normalized === "gpt-5.1-chat-latest" ||
    normalized === "gpt-5.1-codex-max" ||
    normalized === "gpt-5.2" ||
    normalized === "gpt-5.2-chat-latest"
  ) {
    return "gpt-5.5";
  }
  return null;
}

function hasRetiredVersionPrefix(normalized: string, prefix: string): boolean {
  if (normalized === prefix) {
    return true;
  }
  if (!normalized.startsWith(prefix)) {
    return false;
  }
  const next = normalized[prefix.length];
  return next === "-" || next === "." || next === ":" || next === "@";
}

function hasAnyRetiredVersionPrefix(normalized: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => hasRetiredVersionPrefix(normalized, prefix));
}

function upgradeOldClaudeToken(
  token: string,
  separator: "." | "-",
  provider?: string,
): string | null {
  const normalized = normalizeString(token);
  if (!normalized) {
    return null;
  }
  const opusTarget = claudeTargetModelId("opus", separator, provider);
  const sonnetTarget = claudeTargetModelId("sonnet", separator, provider);
  if (
    normalized.startsWith("claude-opus-4-7") ||
    normalized.startsWith("claude-opus-4.7") ||
    normalized.startsWith("claude-opus-4-6") ||
    normalized.startsWith("claude-opus-4.6") ||
    normalized.startsWith("claude-sonnet-4-6") ||
    normalized.startsWith("claude-sonnet-4.6")
  ) {
    return null;
  }
  // claude-haiku-4-5 is a current production model and must not be migrated.
  if (normalized.startsWith("claude-haiku-4-5") || normalized.startsWith("claude-haiku-4.5")) {
    return null;
  }
  if (
    normalized === "claude-opus-4" ||
    hasAnyRetiredVersionPrefix(normalized, [
      "claude-opus-4-5",
      "claude-opus-4.5",
      "claude-opus-4-1",
      "claude-opus-4.1",
      "claude-opus-4-0",
      "claude-opus-4.0",
    ]) ||
    /^claude-opus-4-20\d{6}/.test(normalized)
  ) {
    return opusTarget;
  }
  if (
    normalized === "claude-sonnet-4" ||
    hasAnyRetiredVersionPrefix(normalized, [
      "claude-sonnet-4-5",
      "claude-sonnet-4.5",
      "claude-sonnet-4-1",
      "claude-sonnet-4.1",
      "claude-sonnet-4-0",
      "claude-sonnet-4.0",
    ]) ||
    /^claude-sonnet-4-20\d{6}/.test(normalized)
  ) {
    return sonnetTarget;
  }
  if (normalized.startsWith("claude-3") && normalized.includes("opus")) {
    return opusTarget;
  }
  if (
    normalized.startsWith("claude-3") &&
    (normalized.includes("sonnet") || normalized.includes("haiku"))
  ) {
    return sonnetTarget;
  }
  if (normalized.startsWith("anthropic.claude-opus-")) {
    if (provider === "amazon-bedrock" || provider === "amazon-bedrock-mantle") {
      return null;
    }
    if (
      normalized.startsWith("anthropic.claude-opus-4-7") ||
      normalized.startsWith("anthropic.claude-opus-4-6")
    ) {
      return null;
    }
    return `anthropic.${claudeTargetModelId("opus", "-", provider)}`;
  }
  if (
    normalized.startsWith("anthropic.claude-sonnet-") ||
    normalized.startsWith("anthropic.claude-haiku-")
  ) {
    if (provider === "amazon-bedrock" || provider === "amazon-bedrock-mantle") {
      return null;
    }
    if (normalized.startsWith("anthropic.claude-sonnet-4-6")) {
      return null;
    }
    return `anthropic.${claudeTargetModelId("sonnet", "-", provider)}`;
  }
  if (
    normalized === "opus-4.5" ||
    normalized === "opus-4.1" ||
    normalized === "opus-4" ||
    normalized === "opus-3"
  ) {
    return opusTarget;
  }
  if (
    normalized === "sonnet-4.5" ||
    normalized === "sonnet-4.1" ||
    normalized === "sonnet-4.0" ||
    normalized === "sonnet-4" ||
    normalized === "sonnet-3.7" ||
    normalized === "sonnet-3.5" ||
    normalized === "sonnet-3" ||
    normalized === "haiku-3.5" ||
    normalized === "haiku-3"
  ) {
    return sonnetTarget;
  }
  return null;
}

function upgradeOldClaudeModelPart(model: string, provider: string | undefined): string | null {
  const separator = preferredClaudeSeparator(provider);
  const slashParts = model.split("/");
  const lastPart = slashParts.at(-1);
  if (lastPart) {
    const upgraded = upgradeOldClaudeToken(lastPart, separator, provider);
    if (upgraded) {
      return [...slashParts.slice(0, -1), upgraded].join("/");
    }
  }
  return upgradeOldClaudeToken(model, separator, provider);
}

function upgradeRetiredModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const split = splitTrailingAuthProfile(trimmed);
  const modelRef = split.model;
  const slash = modelRef.indexOf("/");
  const provider = slash > 0 ? modelRef.slice(0, slash).trim() : undefined;
  const model = slash > 0 ? modelRef.slice(slash + 1).trim() : modelRef;
  const normalizedProvider = normalizeString(provider);
  const normalizedModel = normalizeString(model);

  const retiredOwnerModel =
    normalizedProvider === "groq"
      ? upgradeRetiredGroqModelId(model)
      : normalizedProvider === "xai"
        ? upgradeRetiredXaiModelId(model)
        : normalizedProvider === "openai" ||
            normalizedProvider === "openai-codex" ||
            normalizedProvider === "github-copilot"
          ? upgradeRetiredOpenAiModelId(model, normalizedProvider)
          : undefined;
  if (retiredOwnerModel) {
    return `${provider}/${retiredOwnerModel}${split.profile ? `@${split.profile}` : ""}`;
  }

  if (
    (normalizedProvider === "github-copilot" || normalizedProvider === "copilot-proxy") &&
    normalizedModel === "grok-code-fast-1"
  ) {
    return `${provider}/gpt-5.4-mini${split.profile ? `@${split.profile}` : ""}`;
  }
  if (!shouldUpgradeClaudeProvider(normalizedProvider || undefined)) {
    return null;
  }

  const upgradedModel = upgradeOldClaudeModelPart(model, normalizedProvider || undefined);
  if (!upgradedModel || upgradedModel === model) {
    return null;
  }
  const upgraded = provider ? `${provider}/${upgradedModel}` : upgradedModel;
  return `${upgraded}${split.profile ? `@${split.profile}` : ""}`;
}

const MODEL_REF_STRING_KEYS = new Set([
  "model",
  "primary",
  "summaryModel",
  "imageModel",
  "imageGenerationModel",
  "musicGenerationModel",
  "pdfModel",
  "videoGenerationModel",
]);
const MODEL_REF_ARRAY_KEYS = new Set([
  "fallback",
  "fallbacks",
  "allowedModels",
  "modelFallbacks",
  "imageModelFallbacks",
]);
const MODEL_REF_MAP_KEYS = new Set(["models"]);
function pathKey(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function isChannelModelOverridePath(path: string): boolean {
  return path.includes(".modelByChannel.");
}

function isModelPolicyAllowPath(path: string): boolean {
  return path.endsWith(".modelPolicy.allow");
}

function scanKnownModelRefs(value: unknown, key?: string, path = ""): boolean {
  if (typeof value === "string") {
    return Boolean(
      key &&
      (MODEL_REF_STRING_KEYS.has(key) || isChannelModelOverridePath(path)) &&
      upgradeRetiredModelRef(value),
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry, index) =>
      typeof entry === "string" &&
      key &&
      (MODEL_REF_ARRAY_KEYS.has(key) || isModelPolicyAllowPath(path))
        ? Boolean(upgradeRetiredModelRef(entry))
        : scanKnownModelRefs(entry, undefined, `${path}.${index}`),
    );
  }
  const record = getRecord(value);
  if (!record) {
    return false;
  }
  if (key && MODEL_REF_MAP_KEYS.has(key)) {
    return Object.keys(record).some((entryKey) => Boolean(upgradeRetiredModelRef(entryKey)));
  }
  return Object.entries(record).some(([childKey, child]) =>
    scanKnownModelRefs(child, childKey, `${path}.${childKey}`),
  );
}

function collectLegacyDefaultModelAllowRefs(raw: Record<string, unknown>): string[] | null {
  // Marker seeding at the config write boundary ships atomically with metadata-only
  // model maps. Therefore an unmarked map is legacy even if a general write version advanced.
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  return computeModelPolicyAllowlist({
    root: raw,
    defaults,
  });
}

function migrateExplicitDefaultModelAllowPolicy(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  if (hasModelPolicyAllowlistMigrationMarker(raw)) {
    return;
  }
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  const defaultModelPolicy = getRecord(defaults?.modelPolicy);
  const defaultNeedsEvaluation =
    Boolean(getRecord(defaults?.models)) &&
    !(defaultModelPolicy && Object.hasOwn(defaultModelPolicy, "allow"));
  if (!defaultNeedsEvaluation) {
    return;
  }
  const defaultAllow = collectLegacyDefaultModelAllowRefs(raw);
  if (defaultAllow) {
    const mutableDefaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
    const mutableModelPolicy = ensureRecord(mutableDefaults, "modelPolicy");
    // The policy builder still retains configured defaults/fallbacks, so copying the
    // original keys reproduces the legacy effective set, including wildcard expansion.
    mutableModelPolicy.allow = defaultAllow;
  }
  const migrations = ensureRecord(ensureRecord(raw, "meta"), "migrations");
  migrations[MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER] = true;
  changes.push(
    defaultAllow
      ? "Copied the legacy default model map to agents.defaults.modelPolicy.allow."
      : "Recorded the legacy default model map as unrestricted without creating modelPolicy.allow.",
  );
}

function rewriteModelRefString(value: string, path: string, changes: string[]): string {
  const upgraded = upgradeRetiredModelRef(value);
  if (!upgraded) {
    return value;
  }
  changes.push(`Upgraded ${path} from ${JSON.stringify(value)} to ${JSON.stringify(upgraded)}.`);
  return upgraded;
}

function setRecordEntry(record: Record<string, unknown>, key: string, value: unknown): void {
  // Config dictionaries can contain hostile keys; define own properties so
  // rebuilding or copying them never invokes Object.prototype setters.
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function sanitizeModelRefMapEntry(value: unknown): unknown {
  // Collisions combine both entries before recursive ref rewriting, so blocked
  // keys must be removed at every depth on both sides of the merge.
  if (Array.isArray(value)) {
    return value.map(sanitizeModelRefMapEntry);
  }
  const record = getRecord(value);
  if (!record) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(record)) {
    if (!isBlockedObjectKey(field)) {
      setRecordEntry(sanitized, field, sanitizeModelRefMapEntry(child));
    }
  }
  return sanitized;
}

function modelRefValuesAreEqual(existing: unknown, incoming: unknown, path: string): boolean {
  if (isDeepStrictEqual(existing, incoming)) {
    return true;
  }
  const normalizedExisting = rewriteKnownModelRefs(existing, path, []).value;
  const normalizedIncoming = rewriteKnownModelRefs(incoming, path, []).value;
  return isDeepStrictEqual(normalizedExisting, normalizedIncoming);
}

function mergeModelRefMapEntries(
  existing: unknown,
  incoming: unknown,
  path: string,
): { value: unknown; conflicts: string[] } {
  const existingRecord = getRecord(existing);
  const incomingRecord = getRecord(incoming);
  if (!existingRecord || !incomingRecord) {
    return {
      value: sanitizeModelRefMapEntry(existing),
      conflicts: modelRefValuesAreEqual(existing, incoming, path) ? [] : ["value"],
    };
  }
  const merged = sanitizeModelRefMapEntry(existingRecord) as Record<string, unknown>;
  const conflicts: string[] = [];
  for (const [field, incomingValue] of Object.entries(incomingRecord)) {
    if (incomingValue === undefined || isBlockedObjectKey(field)) {
      continue;
    }
    if (!hasOwnDefinedProperty(existingRecord, field)) {
      setRecordEntry(merged, field, sanitizeModelRefMapEntry(incomingValue));
      continue;
    }
    const existingValue = existingRecord[field];
    const fieldPath = `${path}.${field}`;
    if (modelRefValuesAreEqual(existingValue, incomingValue, fieldPath)) {
      continue;
    }
    const existingField = getRecord(existingValue);
    const incomingField = getRecord(incomingValue);
    if (existingField && incomingField) {
      const nested = mergeModelRefMapEntries(existingField, incomingField, fieldPath);
      setRecordEntry(merged, field, nested.value);
      conflicts.push(...nested.conflicts.map((c) => `${field}.${c}`));
      continue;
    }
    conflicts.push(field);
  }
  return { value: merged, conflicts };
}

function rewriteModelRefMapKeys(
  record: Record<string, unknown>,
  path: string,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = {};
  const consumedCanonicalKeys = new Set<string>();
  for (const [key, child] of Object.entries(record)) {
    const upgradedKey = upgradeRetiredModelRef(key);
    const nextKey = upgradedKey ?? key;
    if (!upgradedKey && consumedCanonicalKeys.has(key)) {
      continue;
    }
    if (upgradedKey) {
      changes.push(
        `Upgraded ${path} key from ${JSON.stringify(key)} to ${JSON.stringify(upgradedKey)}.`,
      );
      changed = true;
    }
    if (upgradedKey && !Object.hasOwn(next, nextKey) && Object.hasOwn(record, nextKey)) {
      // Seed the canonical entry before its retired aliases so canonical conflict
      // precedence and per-alias change reporting do not depend on authored key order.
      setRecordEntry(next, nextKey, record[nextKey]);
      consumedCanonicalKeys.add(nextKey);
    }
    if (Object.hasOwn(next, nextKey)) {
      const existing = next[nextKey];
      const { value, conflicts } = mergeModelRefMapEntries(existing, child, `${path}.${nextKey}`);
      setRecordEntry(next, nextKey, value);
      const sortedConflicts = conflicts.toSorted();
      if (sortedConflicts.length > 0) {
        changes.push(
          `Merged ${path} key ${JSON.stringify(key)} into ${JSON.stringify(nextKey)}; kept existing values for conflicting fields: ${sortedConflicts.join(", ")}.`,
        );
      } else {
        changes.push(`Merged ${path} key ${JSON.stringify(key)} into ${JSON.stringify(nextKey)}.`);
      }
      continue;
    }
    setRecordEntry(next, nextKey, child);
  }
  return { value: changed ? next : record, changed };
}

function rewriteKnownModelRefs(
  value: unknown,
  path: string,
  changes: string[],
): { value: unknown; changed: boolean } {
  const key = pathKey(path);
  if (typeof value === "string") {
    if (!MODEL_REF_STRING_KEYS.has(key) && !isChannelModelOverridePath(path)) {
      return { value, changed: false };
    }
    const next = rewriteModelRefString(value, path, changes);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry, index) => {
      if (
        typeof entry === "string" &&
        (MODEL_REF_ARRAY_KEYS.has(key) || isModelPolicyAllowPath(path))
      ) {
        const rewritten = rewriteModelRefString(entry, `${path}.${index}`, changes);
        changed ||= rewritten !== entry;
        return rewritten;
      }
      const rewritten = rewriteKnownModelRefs(entry, `${path}.${index}`, changes);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: changed ? next : value, changed };
  }
  const record = getRecord(value);
  if (!record) {
    return { value, changed: false };
  }

  let working = record;
  let changed = false;
  if (MODEL_REF_MAP_KEYS.has(key)) {
    const rewrittenKeys = rewriteModelRefMapKeys(record, path, changes);
    working = rewrittenKeys.value;
    changed ||= rewrittenKeys.changed;
  }

  const next: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(working)) {
    const rewritten = rewriteKnownModelRefs(child, `${path}.${childKey}`, changes);
    changed ||= rewritten.changed;
    setRecordEntry(next, childKey, rewritten.value);
  }
  return { value: changed ? next : value, changed };
}

const RETIRED_MODEL_REF_MESSAGE =
  'Configured retired model refs are no longer in the bundled catalogs; run "openclaw doctor --fix" to upgrade them.';
const LEGACY_OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CHATGPT_RESPONSES_API = "openai-chatgpt-responses";
const MODEL_UNSCOPED_PROVIDER_DEFAULT_KEYS = [
  "apiKey",
  "auth",
  "request",
  "timeoutSeconds",
  "region",
  "injectNumCtxForOpenAICompat",
  "localService",
  "headers",
  "authHeader",
] as const;
const CANONICAL_PROVIDER_MODEL_LEAK_KEYS = [
  "apiKey",
  "auth",
  "contextWindow",
  "contextTokens",
  "maxTokens",
  "timeoutSeconds",
  "region",
  "injectNumCtxForOpenAICompat",
  "params",
  "agentRuntime",
  "localService",
  "headers",
  "authHeader",
  "request",
] as const;

function hasCanonicalOpenAIProvider(providers: Record<string, unknown>): boolean {
  return Object.keys(providers).some(
    (providerId) => normalizeProviderId(providerId) === OPENAI_PROVIDER_ID,
  );
}

function normalizeLegacyOpenAIResponsesApi(
  providerId: string,
  provider: Record<string, unknown>,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...provider };
  if (next.api === LEGACY_OPENAI_CODEX_RESPONSES_API) {
    next.api = OPENAI_CHATGPT_RESPONSES_API;
    changes.push(
      `Moved models.providers.${providerId}.api "${LEGACY_OPENAI_CODEX_RESPONSES_API}" → "${OPENAI_CHATGPT_RESPONSES_API}".`,
    );
    changed = true;
  }

  if (Array.isArray(provider.models)) {
    let modelsChanged = false;
    const nextModels = provider.models.map((model, index) => {
      const modelRecord = getRecord(model);
      if (!modelRecord || modelRecord.api !== LEGACY_OPENAI_CODEX_RESPONSES_API) {
        return model;
      }
      modelsChanged = true;
      changes.push(
        `Moved models.providers.${providerId}.models[${index}].api "${LEGACY_OPENAI_CODEX_RESPONSES_API}" → "${OPENAI_CHATGPT_RESPONSES_API}".`,
      );
      return {
        ...modelRecord,
        api: OPENAI_CHATGPT_RESPONSES_API,
      };
    });
    if (modelsChanged) {
      next.models = nextModels;
      changed = true;
    }
  }

  return { value: next, changed };
}

function hasOwnDefinedProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function collectModelMergeBlockers(params: {
  canonical: Record<string, unknown>;
  legacy: Record<string, unknown>;
  legacyProviderId: string;
}): string[] {
  const blockers: string[] = [];
  for (const key of MODEL_UNSCOPED_PROVIDER_DEFAULT_KEYS) {
    if (hasOwnDefinedProperty(params.legacy, key)) {
      blockers.push(`models.providers.${params.legacyProviderId}.${key}`);
    }
  }
  for (const key of CANONICAL_PROVIDER_MODEL_LEAK_KEYS) {
    if (hasOwnDefinedProperty(params.canonical, key)) {
      blockers.push(`models.providers.${OPENAI_PROVIDER_ID}.${key}`);
    }
  }
  return blockers;
}

function getCanonicalOpenAIProviderEntry(
  providers: Record<string, unknown>,
): { key: string; value: Record<string, unknown> } | undefined {
  const key = Object.keys(providers).find((k) => normalizeProviderId(k) === OPENAI_PROVIDER_ID);
  const value = key ? getRecord(providers[key]) : undefined;
  return key && value ? { key, value } : undefined;
}

function getMergeableLegacyOpenAIModels(params: {
  canonical: Record<string, unknown>;
  legacy: Record<string, unknown>;
}): unknown[] {
  const legacyModels: unknown[] = Array.isArray(params.legacy.models)
    ? (params.legacy.models as unknown[])
    : [];
  const canonicalModels: unknown[] = Array.isArray(params.canonical.models)
    ? (params.canonical.models as unknown[])
    : [];
  const canonicalModelIds = new Set<string>();
  const canonicalModelNames = new Set<string>();
  for (const m of canonicalModels) {
    const mr = getRecord(m);
    if (typeof mr?.id === "string" && mr.id) {
      canonicalModelIds.add(mr.id);
    }
    if (typeof mr?.name === "string" && mr.name) {
      canonicalModelNames.add(mr.name);
    }
  }
  return legacyModels.filter((m) => {
    const mr = getRecord(m);
    if (!mr) {
      return false;
    }
    const id = typeof mr.id === "string" ? mr.id : undefined;
    const name = typeof mr.name === "string" ? mr.name : undefined;
    if (!id && !name) {
      return false;
    }
    return id ? !canonicalModelIds.has(id) : name ? !canonicalModelNames.has(name) : false;
  });
}

function collectLegacyModelPolicyWildcardPaths(raw: unknown): Map<string, string[]> {
  const pathsByProvider = new Map<string, string[]>();
  const agents = getRecord(getRecord(raw)?.agents);
  const scopes: Array<{ value: unknown; path: string }> = [
    { value: getRecord(agents?.defaults)?.modelPolicy, path: "agents.defaults.modelPolicy" },
  ];
  const list = Array.isArray(agents?.list) ? agents.list : [];
  for (const [index, agent] of list.entries()) {
    scopes.push({
      value: getRecord(agent)?.modelPolicy,
      path: `agents.list.${index}.modelPolicy`,
    });
  }
  for (const scope of scopes) {
    const allow = getRecord(scope.value)?.allow;
    if (!Array.isArray(allow)) {
      continue;
    }
    for (const [index, entry] of allow.entries()) {
      if (typeof entry !== "string" || !entry.trim().endsWith("/*")) {
        continue;
      }
      const provider = normalizeProviderId(entry.trim().slice(0, -2));
      if (!isLegacyCodexProviderId(provider)) {
        continue;
      }
      const paths = pathsByProvider.get(provider) ?? [];
      paths.push(`${scope.path}.allow.${index}`);
      pathsByProvider.set(provider, paths);
    }
  }
  return pathsByProvider;
}

function hasAutoFixableLegacyOpenAICodexProvider(
  providersValue: unknown,
  root?: Record<string, unknown>,
): boolean {
  const providers = getRecord(providersValue);
  if (!providers) {
    return false;
  }
  const wildcardPaths = collectLegacyModelPolicyWildcardPaths(root);
  const canonicalEntry = getCanonicalOpenAIProviderEntry(providers);
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    if (!provider || !isLegacyCodexProviderId(providerId)) {
      continue;
    }
    if (wildcardPaths.has(normalizeProviderId(providerId))) {
      continue;
    }
    const normalized = normalizeLegacyOpenAIResponsesApi(providerId, provider, []);
    if (normalized.changed || !canonicalEntry) {
      return true;
    }
    const modelCollisions = collectNonEquivalentLegacyOpenAIModelCollisions({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (modelCollisions.length > 0) {
      continue;
    }
    const modelsToMerge = getMergeableLegacyOpenAIModels({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
    });
    if (modelsToMerge.length === 0) {
      return true;
    }
    const mergeBlockers = collectModelMergeBlockers({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (mergeBlockers.length === 0) {
      return true;
    }
  }
  return false;
}

export type BlockedLegacyOpenAICodexProviderPlan = {
  blockedModelIdentities: LegacyCodexModelIdentity[];
  warning?: string;
};

/** Compute the provider-merge blockers once so every doctor state repair shares the decision. */
export function collectBlockedLegacyOpenAICodexProviderPlan(
  raw: unknown,
): BlockedLegacyOpenAICodexProviderPlan {
  const models = getRecord(getRecord(raw)?.models);
  const providers = getRecord(models?.providers);
  const canonicalEntry = providers ? getCanonicalOpenAIProviderEntry(providers) : undefined;
  const blockedModelIdentities = new Set<LegacyCodexModelIdentity>();
  const warningLines: string[] = [];
  for (const [providerId, paths] of collectLegacyModelPolicyWildcardPaths(raw)) {
    const identity = legacyCodexProviderIdentityKey(providerId);
    if (identity) {
      blockedModelIdentities.add(identity);
    }
    warningLines.push(
      `- ${paths.join(", ")} cannot migrate automatically because ${providerId}/* would become openai/* and authorize unrelated OpenAI models.`,
    );
  }
  if (!providers || !canonicalEntry) {
    return buildBlockedLegacyOpenAICodexProviderPlan(blockedModelIdentities, warningLines);
  }

  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    if (!provider || !isLegacyCodexProviderId(providerId)) {
      continue;
    }
    const normalized = normalizeLegacyOpenAIResponsesApi(providerId, provider, []);
    const modelCollisions = collectNonEquivalentLegacyOpenAIModelCollisions({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (modelCollisions.length > 0) {
      const identity = legacyCodexProviderIdentityKey(providerId);
      if (identity) {
        blockedModelIdentities.add(identity);
      }
      warningLines.push(
        `- models.providers.${providerId} cannot be merged automatically into models.providers.${canonicalEntry.key} because colliding model definitions differ for: ${modelCollisions.join(", ")}.`,
      );
      continue;
    }
    const modelsToMerge = getMergeableLegacyOpenAIModels({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
    });
    if (modelsToMerge.length === 0) {
      continue;
    }
    const mergeBlockers = collectModelMergeBlockers({
      canonical: canonicalEntry.value,
      legacy: normalized.value,
      legacyProviderId: providerId,
    });
    if (mergeBlockers.length === 0) {
      continue;
    }
    const identity = legacyCodexProviderIdentityKey(providerId);
    if (identity) {
      blockedModelIdentities.add(identity);
    }
    warningLines.push(
      `- models.providers.${providerId} cannot be merged automatically into models.providers.${canonicalEntry.key} because provider-level defaults cannot be represented safely on merged models: ${mergeBlockers.join(", ")}.`,
    );
  }
  // Intentionally fail closed: retained legacy refs are NOT executable until
  // reconciled (the live codex provider is gone, and a hidden resolver/auth
  // shim is forbidden by policy). Only hand-authored models.providers.codex
  // definitions can reach this state; the warning names the exact repair.
  return buildBlockedLegacyOpenAICodexProviderPlan(blockedModelIdentities, warningLines);
}

function buildBlockedLegacyOpenAICodexProviderPlan(
  blockedModelIdentities: ReadonlySet<LegacyCodexModelIdentity>,
  warningLines: string[],
): BlockedLegacyOpenAICodexProviderPlan {
  return {
    blockedModelIdentities: [...blockedModelIdentities],
    ...(warningLines.length > 0
      ? {
          warning: [
            "Legacy Codex provider routes require manual reconciliation before matching refs can migrate.",
            ...warningLines,
            "- Doctor retained matching legacy refs in config, sessions, and cron. These refs will not execute until reconciled: fix the model route/auth metadata, remove the legacy provider entry, then rerun `openclaw doctor --fix`.",
          ].join("\n"),
        }
      : {}),
  };
}

function resolveMovedCodexModelRuntime(params: {
  legacyProviderId: string;
  legacyProvider: Record<string, unknown>;
  model: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  if (normalizeProviderId(params.legacyProviderId) !== "codex") {
    return undefined;
  }
  const modelRuntime = getRecord(params.model.agentRuntime);
  const modelRuntimeId = normalizeOptionalAgentRuntimeId(modelRuntime?.id);
  if (modelRuntimeId && modelRuntimeId !== "auto") {
    return undefined;
  }
  if (modelRuntimeId === "auto") {
    return { ...modelRuntime, id: "codex" };
  }
  const providerRuntime = getRecord(params.legacyProvider.agentRuntime);
  const providerRuntimeId = normalizeOptionalAgentRuntimeId(providerRuntime?.id);
  // Converting provider-level auto must keep its sibling policy fields
  // (e.g. fallback: "none"), matching the model-level branch above.
  return providerRuntimeId && providerRuntimeId !== "auto"
    ? (providerRuntime ?? undefined)
    : { ...providerRuntime, id: "codex" };
}

function buildMergedLegacyOpenAIModel(
  model: unknown,
  legacyProvider: Record<string, unknown>,
  legacyProviderId: string,
): unknown {
  const modelRecord = getRecord(model);
  if (!modelRecord) {
    return model;
  }

  const patch: Record<string, unknown> = {};
  const legacyBaseUrl =
    typeof legacyProvider.baseUrl === "string" ? legacyProvider.baseUrl : undefined;
  const legacyApi = typeof legacyProvider.api === "string" ? legacyProvider.api : undefined;
  const legacyParams = getRecord(legacyProvider.params);
  const legacyAgentRuntime = getRecord(legacyProvider.agentRuntime);
  const movedCodexRuntime = resolveMovedCodexModelRuntime({
    legacyProviderId,
    legacyProvider,
    model: modelRecord,
  });

  if (legacyBaseUrl && !modelRecord.baseUrl) {
    patch.baseUrl = legacyBaseUrl;
  }
  if (legacyApi && !modelRecord.api) {
    patch.api = legacyApi;
  }
  for (const key of ["contextWindow", "contextTokens", "maxTokens"] as const) {
    if (typeof legacyProvider[key] === "number" && modelRecord[key] === undefined) {
      patch[key] = legacyProvider[key];
    }
  }
  if (legacyParams) {
    const modelParams = getRecord(modelRecord.params);
    if (modelParams) {
      patch.params = { ...legacyParams, ...modelParams };
    } else if (modelRecord.params === undefined) {
      patch.params = legacyParams;
    }
  }
  if (movedCodexRuntime) {
    patch.agentRuntime = movedCodexRuntime;
  } else if (legacyAgentRuntime && modelRecord.agentRuntime === undefined) {
    patch.agentRuntime = legacyAgentRuntime;
  }
  if (
    modelRecord.metadataSource === undefined &&
    isLegacyModelsAddCodexMetadataModel({
      provider: legacyProviderId,
      model: modelRecord as Partial<ModelDefinitionConfig>,
    })
  ) {
    patch.metadataSource = "models-add";
  }
  return Object.keys(patch).length > 0 ? Object.assign({}, modelRecord, patch) : model;
}

function collectNonEquivalentLegacyOpenAIModelCollisions(params: {
  canonical: Record<string, unknown>;
  legacy: Record<string, unknown>;
  legacyProviderId: string;
}): string[] {
  const canonicalModels = Array.isArray(params.canonical.models) ? params.canonical.models : [];
  const legacyModels = Array.isArray(params.legacy.models) ? params.legacy.models : [];
  const conflicts = new Set<string>();

  for (const legacyModel of legacyModels) {
    const legacyRecord = getRecord(legacyModel);
    const legacyId = typeof legacyRecord?.id === "string" ? legacyRecord.id : undefined;
    const legacyName = typeof legacyRecord?.name === "string" ? legacyRecord.name : undefined;
    if (!legacyRecord || (!legacyId && !legacyName)) {
      continue;
    }
    const collisions = canonicalModels.filter((canonicalModel) => {
      const canonicalRecord = getRecord(canonicalModel);
      return legacyId ? canonicalRecord?.id === legacyId : canonicalRecord?.name === legacyName;
    });
    if (collisions.length === 0) {
      continue;
    }
    const legacyEffective = buildMergedLegacyOpenAIModel(
      legacyModel,
      params.legacy,
      params.legacyProviderId,
    );
    const definitionsMatch = collisions.every((canonicalModel) => {
      const canonicalEffective = buildMergedLegacyOpenAIModel(
        canonicalModel,
        params.canonical,
        OPENAI_PROVIDER_ID,
      );
      if (!isDeepStrictEqual(canonicalEffective, legacyEffective)) {
        return false;
      }
      return MODEL_UNSCOPED_PROVIDER_DEFAULT_KEYS.every((key) =>
        isDeepStrictEqual(params.canonical[key], params.legacy[key]),
      );
    });
    if (!definitionsMatch) {
      conflicts.add(legacyId ?? legacyName ?? "unknown");
    }
  }

  return [...conflicts];
}

function prepareLegacyCodexProviderForCanonicalMove(
  providerId: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  if (normalizeProviderId(providerId) !== "codex" || !Array.isArray(provider.models)) {
    return provider;
  }
  return {
    ...provider,
    models: provider.models.map((model) => {
      const record = getRecord(model);
      if (!record) {
        return model;
      }
      const agentRuntime = resolveMovedCodexModelRuntime({
        legacyProviderId: providerId,
        legacyProvider: provider,
        model: record,
      });
      return agentRuntime ? { ...record, agentRuntime } : model;
    }),
  };
}

function migrateLegacyOpenAICodexProvider(raw: Record<string, unknown>, changes: string[]): void {
  const models = getRecord(raw.models);
  const providers = getRecord(models?.providers);
  if (!models || !providers) {
    return;
  }

  let providersChanged = false;
  const wildcardPaths = collectLegacyModelPolicyWildcardPaths(raw);
  for (const [providerId, providerValue] of Object.entries({ ...providers })) {
    const provider = getRecord(providers[providerId]) ?? getRecord(providerValue);
    if (!provider) {
      continue;
    }
    if (isLegacyCodexProviderId(providerId) && wildcardPaths.has(normalizeProviderId(providerId))) {
      continue;
    }

    const normalized = normalizeLegacyOpenAIResponsesApi(providerId, provider, changes);
    if (!isLegacyCodexProviderId(providerId)) {
      if (normalized.changed) {
        providers[providerId] = normalized.value;
        providersChanged = true;
      }
      continue;
    }

    if (!hasCanonicalOpenAIProvider(providers)) {
      providers[OPENAI_PROVIDER_ID] = prepareLegacyCodexProviderForCanonicalMove(
        providerId,
        normalized.value,
      );
      changes.push(
        `Moved models.providers.${providerId} → models.providers.${OPENAI_PROVIDER_ID}.`,
      );
    } else {
      // Canonical openai provider already exists. Merge non-conflicting model
      // entries from the legacy provider so disjoint models (e.g. a chat model
      // on the Codex OAuth path alongside an embeddings-only openai provider)
      // are preserved instead of silently dropped. (#90047)
      const canonicalEntry = getCanonicalOpenAIProviderEntry(providers);
      const canonicalKey = canonicalEntry?.key ?? OPENAI_PROVIDER_ID;
      const canonical = canonicalEntry?.value ?? {};
      const canonicalModels: unknown[] = Array.isArray(canonical.models)
        ? (canonical.models as unknown[])
        : [];
      const modelCollisions = collectNonEquivalentLegacyOpenAIModelCollisions({
        canonical,
        legacy: normalized.value,
        legacyProviderId: providerId,
      });
      const modelsToMerge = getMergeableLegacyOpenAIModels({
        canonical,
        legacy: normalized.value,
      });
      const mergeBlockers =
        modelCollisions.length === 0 && modelsToMerge.length > 0
          ? collectModelMergeBlockers({
              canonical,
              legacy: normalized.value,
              legacyProviderId: providerId,
            })
          : [];
      if (modelCollisions.length > 0 || mergeBlockers.length > 0) {
        if (normalized.changed) {
          providers[providerId] = normalized.value;
          providersChanged = true;
          changes.push(
            modelCollisions.length > 0
              ? `Skipped merging models.providers.${providerId} into models.providers.${OPENAI_PROVIDER_ID} because colliding model definitions differ for: ${modelCollisions.join(", ")}.`
              : `Skipped merging models.providers.${providerId} into models.providers.${OPENAI_PROVIDER_ID} because provider-level defaults cannot be represented safely on merged models: ${mergeBlockers.join(", ")}.`,
          );
        }
        continue;
      }
      // Stamp model-scoped legacy provider defaults onto each merged model so it
      // keeps the Codex endpoint and runtime metadata instead of inheriting the
      // canonical provider's OpenAI platform defaults.
      const stamped = modelsToMerge.map((m) =>
        buildMergedLegacyOpenAIModel(m, normalized.value, providerId),
      );
      if (stamped.length > 0) {
        providers[canonicalKey] = { ...canonical, models: [...canonicalModels, ...stamped] };
        const mergedIds = stamped
          .map((m) => {
            const mr = getRecord(m);
            return typeof mr?.id === "string" && mr.id
              ? mr.id
              : typeof mr?.name === "string" && mr.name
                ? mr.name
                : "unknown";
          })
          .join(", ");
        changes.push(
          `Merged ${stamped.length} model(s) from models.providers.${providerId} into models.providers.${OPENAI_PROVIDER_ID}: ${mergedIds}.`,
        );
      } else {
        changes.push(
          `Removed models.providers.${providerId} because models.providers.${OPENAI_PROVIDER_ID} already exists.`,
        );
      }
    }
    delete providers[providerId];
    providersChanged = true;
  }

  if (providersChanged) {
    models.providers = providers;
  }
}

const RETIRED_MODEL_REF_RULES: LegacyConfigRule[] = [
  "agents",
  "plugins",
  "messages",
  "tools",
  "hooks",
  "channels",
  "models",
].map((section) => ({
  path: [section],
  message: RETIRED_MODEL_REF_MESSAGE,
  match: (value) => scanKnownModelRefs(value),
}));

/** Legacy config migration specs for model/provider runtime config compatibility. */
const LEGACY_DEFAULT_MODEL_MIGRATION = defineLegacyConfigMigration({
  id: "defaultModel->agents.defaults.model",
  describe: "Move the retired root default model to agent defaults",
  legacyRules: [
    {
      path: ["defaultModel"],
      message: 'defaultModel moved to agents.defaults.model. Run "openclaw doctor --fix".',
    },
  ],
  apply: (raw, changes) => {
    if (!Object.hasOwn(raw, "defaultModel")) {
      return;
    }
    const legacyDefaultModel = raw.defaultModel;
    const currentDefaults = getRecord(getRecord(raw.agents)?.defaults);
    if (currentDefaults?.model === undefined && typeof legacyDefaultModel === "string") {
      const defaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
      defaults.model = legacyDefaultModel;
      changes.push("Moved defaultModel → agents.defaults.model.");
    } else {
      changes.push("Removed defaultModel (agents.defaults.model already set or value invalid).");
    }
    delete raw.defaultModel;
  },
});

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS: LegacyConfigMigrationSpec[] = [
  LEGACY_DEFAULT_MODEL_MIGRATION,
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat->provider-catalog",
    describe: "Move known-model compatibility capability ownership into provider catalogs",
    legacyRules: MODEL_COMPAT_CATALOG_RULES,
    apply: migrateModelCompatCatalogOwnership,
  }),
  defineLegacyConfigMigration({
    id: "models.providers.codex-routes->models.providers.openai",
    describe: "Move legacy Codex-route provider config to canonical OpenAI provider config",
    legacyRules: [
      {
        path: ["models", "providers"],
        message:
          'models.providers.codex and models.providers.openai-codex are legacy; run "openclaw doctor --fix" to move them to models.providers.openai.',
        match: (value, root) => hasAutoFixableLegacyOpenAICodexProvider(value, root),
      },
      {
        path: ["models", "providers"],
        message:
          'openai-codex-responses is legacy; run "openclaw doctor --fix" to use openai-chatgpt-responses.',
        match: (value) => {
          const providers = getRecord(value);
          return providers
            ? Object.values(providers).some((providerValue) => {
                const provider = getRecord(providerValue);
                return (
                  provider?.api === LEGACY_OPENAI_CODEX_RESPONSES_API ||
                  (Array.isArray(provider?.models) &&
                    provider.models.some(
                      (model) => getRecord(model)?.api === LEGACY_OPENAI_CODEX_RESPONSES_API,
                    ))
                );
              })
            : false;
        },
      },
    ],
    apply: migrateLegacyOpenAICodexProvider,
  }),
  defineLegacyConfigMigration({
    id: "models.retired-model-refs",
    describe: "Upgrade retired model refs to current catalog entries",
    legacyRules: RETIRED_MODEL_REF_RULES,
    apply: (raw, changes) => {
      const rewritten = rewriteKnownModelRefs(raw, "config", changes);
      const rewrittenRecord = getRecord(rewritten.value);
      if (!rewritten.changed || !rewrittenRecord) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      for (const [key, value] of Object.entries(rewrittenRecord)) {
        setRecordEntry(raw, key, value);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.models->agents.defaults.modelPolicy.allow",
    describe: "Make the legacy model override restriction explicit",
    legacyRules: [
      {
        path: ["agents", "defaults", "models"],
        message:
          'agents.defaults.models no longer restricts model overrides; run "openclaw doctor --fix" to preserve the previous restriction in agents.defaults.modelPolicy.allow.',
        match: (_value, root) => collectLegacyDefaultModelAllowRefs(root) !== null,
      },
    ],
    apply: migrateExplicitDefaultModelAllowPolicy,
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.models.vllm.params.qwenThinkingFormat->models.providers.vllm.models.compat.thinkingFormat",
    describe: "Move legacy vLLM Qwen thinking params to model compat metadata",
    legacyRules: [
      LEGACY_VLLM_QWEN_AGENT_THINKING_FORMAT_RULE,
      LEGACY_VLLM_QWEN_PROVIDER_THINKING_FORMAT_RULE,
      LEGACY_VLLM_QWEN_PROVIDER_MODEL_THINKING_FORMAT_RULE,
      LEGACY_VLLM_QWEN_NORMALIZED_PROVIDER_THINKING_FORMAT_RULE,
      LEGACY_VLLM_QWEN_DEFAULT_PARAMS_THINKING_FORMAT_RULE,
      LEGACY_VLLM_QWEN_AGENT_PARAMS_THINKING_FORMAT_RULE,
    ],
    apply: (raw, changes) => {
      const agentsDefaults = getRecord(getRecord(raw.agents)?.defaults);
      const defaultModels = getRecord(agentsDefaults?.models);
      if (defaultModels) {
        for (const [key, entry] of Object.entries(defaultModels)) {
          const modelId = parseVllmAgentModelKey(key);
          const entryRecord = getRecord(entry);
          const params = getRecord(entryRecord?.params);
          if (!modelId || !entryRecord || !params) {
            continue;
          }

          const legacyFormat = getLegacyVllmQwenThinkingFormat(params);
          if (!legacyFormat) {
            continue;
          }

          const target = legacyFormat.compat ? findOrCreateVllmModelEntry(raw, modelId) : undefined;
          if (legacyFormat.compat && !target) {
            continue;
          }
          applyLegacyVllmQwenThinkingFormat({
            sourcePath: `agents.defaults.models.${JSON.stringify(key)}.params`,
            legacyParams: params,
            target: target ?? { model: {}, index: -1 },
            legacyFormat,
            changes,
          });
          if (Object.keys(params).length === 0) {
            delete entryRecord.params;
          }
        }
      }

      const vllmProvider = findVllmProvider(getRecord(getRecord(raw.models)?.providers));
      const vllmModels = vllmProvider?.models;
      if (Array.isArray(vllmModels)) {
        for (const [index, model] of vllmModels.entries()) {
          const modelRecord = getRecord(model);
          const params = getRecord(modelRecord?.params);
          if (!modelRecord || !params) {
            continue;
          }
          const legacyFormat = getLegacyVllmQwenThinkingFormat(params);
          if (!legacyFormat) {
            continue;
          }
          applyLegacyVllmQwenThinkingFormat({
            sourcePath: `models.providers.vllm.models[${index}].params`,
            legacyParams: params,
            target: { model: modelRecord, index },
            legacyFormat,
            changes,
          });
          if (Object.keys(params).length === 0) {
            delete modelRecord.params;
          }
        }
      }

      const providerParams = getRecord(vllmProvider?.params);
      if (providerParams) {
        const providerLegacyFormat = getLegacyVllmQwenThinkingFormat(providerParams);
        if (providerLegacyFormat) {
          const providerModelIds = [
            ...collectVllmModelIdsFromSelection(agentsDefaults?.model),
            ...collectVllmModelIdsFromAgentModelMap(defaultModels),
            ...collectVllmModelIdsFromAgentList(getRecord(raw.agents)?.list),
          ];
          const targets = combineVllmModelTargets(
            listExistingVllmModelTargets(raw),
            createVllmModelTargets(raw, providerModelIds),
          );
          if (targets.length === 0) {
            removeUntargetedLegacyVllmQwenThinkingFormat({
              sourcePath: "models.providers.vllm.params",
              legacyParams: providerParams,
              legacyFormat: providerLegacyFormat,
              changes,
            });
          } else {
            for (const target of targets) {
              applyLegacyVllmQwenThinkingFormat({
                sourcePath: "models.providers.vllm.params",
                legacyParams: providerParams,
                target,
                legacyFormat: providerLegacyFormat,
                changes,
              });
            }
          }
          if (Object.keys(providerParams).length === 0) {
            delete vllmProvider?.params;
          }
        }
      }

      const defaultParams = getRecord(agentsDefaults?.params);
      if (defaultParams) {
        const defaultLegacyFormat = getLegacyVllmQwenThinkingFormat(defaultParams);
        if (defaultLegacyFormat) {
          const defaultModelIds = [
            ...collectVllmModelIdsFromSelection(agentsDefaults?.model),
            ...collectVllmModelIdsFromAgentModelMap(defaultModels),
          ];
          const targets =
            defaultModelIds.length > 0
              ? createVllmModelTargets(raw, defaultModelIds)
              : listExistingVllmModelTargets(raw);
          if (targets.length === 0) {
            removeUntargetedLegacyVllmQwenThinkingFormat({
              sourcePath: "agents.defaults.params",
              legacyParams: defaultParams,
              legacyFormat: defaultLegacyFormat,
              changes,
            });
          } else {
            for (const target of targets) {
              applyLegacyVllmQwenThinkingFormat({
                sourcePath: "agents.defaults.params",
                legacyParams: defaultParams,
                target,
                legacyFormat: defaultLegacyFormat,
                changes,
              });
            }
          }
          if (Object.keys(defaultParams).length === 0) {
            delete agentsDefaults?.params;
          }
        }
      }

      const agentList = getRecord(raw.agents)?.list;
      if (!Array.isArray(agentList)) {
        return;
      }
      for (const [index, agent] of agentList.entries()) {
        const agentRecord = getRecord(agent);
        const agentParams = getRecord(agentRecord?.params);
        const agentLegacyFormat = agentParams
          ? getLegacyVllmQwenThinkingFormat(agentParams)
          : undefined;
        if (!agentRecord || !agentParams || !agentLegacyFormat) {
          continue;
        }
        const explicitAgentModelIds = [
          ...collectVllmModelIdsFromSelection(agentRecord.model),
          ...collectVllmModelIdsFromAgentModelMap(agentRecord.models),
        ];
        const inheritedDefaultModelIds = [
          ...collectVllmModelIdsFromSelection(agentsDefaults?.model),
          ...collectVllmModelIdsFromAgentModelMap(defaultModels),
        ];
        const agentModelIds =
          explicitAgentModelIds.length > 0 ? explicitAgentModelIds : inheritedDefaultModelIds;
        const targets =
          agentModelIds.length > 0
            ? createVllmModelTargets(raw, agentModelIds)
            : listExistingVllmModelTargets(raw);
        if (targets.length === 0) {
          removeUntargetedLegacyVllmQwenThinkingFormat({
            sourcePath: `agents.list[${index}].params`,
            legacyParams: agentParams,
            legacyFormat: agentLegacyFormat,
            changes,
          });
        } else {
          for (const target of targets) {
            applyLegacyVllmQwenThinkingFormat({
              sourcePath: `agents.list[${index}].params`,
              legacyParams: agentParams,
              target,
              legacyFormat: agentLegacyFormat,
              changes,
            });
          }
        }
        if (Object.keys(agentParams).length === 0) {
          delete agentRecord.params;
        }
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
    describe: "Remove unrecognized compat.thinkingFormat values from provider model entries",
    legacyRules: [INVALID_THINKING_FORMAT_RULE],
    apply: (raw, changes) => {
      const providers = getRecord(getRecord(raw.models)?.providers);
      if (!providers) {
        return;
      }

      for (const [providerId, provider] of Object.entries(providers)) {
        const models = getRecord(provider)?.models;
        if (!Array.isArray(models)) {
          continue;
        }

        for (const [index, model] of models.entries()) {
          const compat = getRecord(getRecord(model)?.compat);
          if (!compat) {
            continue;
          }
          const thinkingFormat = compat.thinkingFormat;
          if (typeof thinkingFormat !== "string" || isModelThinkingFormat(thinkingFormat)) {
            continue;
          }

          delete compat.thinkingFormat;
          changes.push(
            `Removed models.providers.${providerId}.models.${index}.compat.thinkingFormat (unrecognized value ${JSON.stringify(thinkingFormat)}; runtime default applies).`,
          );
        }
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.contextWindow-stale",
    describe: "Repair stale contextWindow values to match catalog defaults",
    legacyRules: [STALE_CONTEXT_WINDOW_RULE],
    apply: (raw, changes) => {
      const providers = getRecord(getRecord(raw.models)?.providers);
      if (!providers) {
        return;
      }

      for (const [providerId, provider] of Object.entries(providers)) {
        const models = getRecord(provider)?.models;
        if (!Array.isArray(models)) {
          continue;
        }

        for (const [index, model] of models.entries()) {
          if (!getRecord(model)) {
            continue;
          }
          const modelId = typeof model.id === "string" ? model.id : undefined;
          if (!modelId) {
            continue;
          }
          const contextWindow = model.contextWindow;
          if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
            continue;
          }

          const fix = resolveStaleContextWindowFix({ providerId, modelId, contextWindow });
          if (!fix) {
            continue;
          }

          model.contextWindow = fix.correct;
          changes.push(
            `Repaired models.providers.${providerId}.models[${index}].${modelId}.contextWindow (${contextWindow} → ${fix.correct} to match catalog default).`,
          );
        }
      }
    },
  }),
];
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
