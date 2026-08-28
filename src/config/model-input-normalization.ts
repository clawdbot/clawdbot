// Normalizes user-submitted model config at config mutation boundaries.
import {
  normalizeConfiguredProviderCatalogModelId,
  type ManifestModelIdNormalizationProvider,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { isRecord } from "../utils.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  normalizeAgentModelSelectionForConfig,
} from "./model-input.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const MODEL_SELECTION_KEYS = ["model", "imageModel", "voiceModel", "pdfModel"] as const;
const MEDIA_MODEL_KEYS = ["image", "video", "music"] as const;

function normalizeStringModelRef(value: unknown): unknown {
  return typeof value === "string" ? normalizeAgentModelRefForConfig(value) : value;
}

function normalizeNestedModelField(
  value: unknown,
  key: string,
  normalize: (candidate: unknown) => unknown,
): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, key)) {
    return value;
  }
  const normalized = normalize(value[key]);
  return normalized === value[key] ? value : { ...value, [key]: normalized };
}

function normalizeAgentModelScope(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  let next = value;
  const assign = (key: string, candidate: unknown) => {
    if (candidate === next[key]) {
      return;
    }
    next = { ...next, [key]: candidate };
  };

  for (const key of MODEL_SELECTION_KEYS) {
    if (Object.hasOwn(value, key)) {
      assign(key, normalizeAgentModelSelectionForConfig(value[key]));
    }
  }
  if (Object.hasOwn(value, "utilityModel")) {
    assign("utilityModel", normalizeStringModelRef(value.utilityModel));
  }
  const originalMediaModels = value.mediaModels;
  if (isRecord(originalMediaModels)) {
    let mediaModelsChanged = false;
    const mediaModels = { ...originalMediaModels };
    for (const key of MEDIA_MODEL_KEYS) {
      if (!Object.hasOwn(originalMediaModels, key)) {
        continue;
      }
      const normalized = normalizeAgentModelSelectionForConfig(originalMediaModels[key]);
      if (normalized !== mediaModels[key]) {
        mediaModels[key] = normalized;
        mediaModelsChanged = true;
      }
    }
    if (mediaModelsChanged) {
      assign("mediaModels", mediaModels);
    }
  }
  assign("heartbeat", normalizeNestedModelField(value.heartbeat, "model", normalizeStringModelRef));
  assign(
    "subagents",
    normalizeNestedModelField(value.subagents, "model", normalizeAgentModelSelectionForConfig),
  );

  if (isRecord(value.compaction)) {
    let compaction = normalizeNestedModelField(value.compaction, "model", normalizeStringModelRef);
    if (isRecord(compaction)) {
      const memoryFlush = normalizeNestedModelField(
        compaction.memoryFlush,
        "model",
        normalizeStringModelRef,
      );
      if (memoryFlush !== compaction.memoryFlush) {
        compaction = { ...compaction, memoryFlush };
      }
    }
    assign("compaction", compaction);
  }
  if (isRecord(value.models)) {
    assign("models", normalizeAgentModelMapForConfig(value.models));
  }
  return next;
}

function normalizeAgentScopes(agents: unknown): unknown {
  if (!isRecord(agents)) {
    return agents;
  }
  let next = agents;
  const assign = (key: string, candidate: unknown) => {
    if (candidate === next[key]) {
      return;
    }
    next = { ...next, [key]: candidate };
  };

  if (Object.hasOwn(agents, "defaults")) {
    assign("defaults", normalizeAgentModelScope(agents.defaults));
  }
  if (isRecord(agents.entries)) {
    let entriesChanged = false;
    const entries = Object.fromEntries(
      Object.entries(agents.entries).map(([agentId, entry]) => {
        const normalized = normalizeAgentModelScope(entry);
        entriesChanged ||= normalized !== entry;
        return [agentId, normalized];
      }),
    );
    if (entriesChanged) {
      assign("entries", entries);
    }
  }
  if (Array.isArray(agents.list)) {
    const originalList = agents.list;
    const list = originalList.map(normalizeAgentModelScope);
    if (list.some((entry, index) => entry !== originalList[index])) {
      assign("list", list);
    }
  }
  return next;
}

function normalizeProviderCatalogs(
  models: unknown,
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): unknown {
  if (!isRecord(models) || !isRecord(models.providers)) {
    return models;
  }

  let providersChanged = false;
  const providers = Object.fromEntries(
    Object.entries(models.providers).map(([providerId, providerValue]) => {
      if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) {
        return [providerId, providerValue];
      }
      const originalModels = providerValue.models;
      const providerModels = originalModels.map((model) => {
        if (!isRecord(model) || typeof model.id !== "string") {
          return model;
        }
        const trimmed = model.id.trim();
        if (!trimmed) {
          return model;
        }
        const id = normalizeConfiguredProviderCatalogModelId(
          providerId,
          trimmed,
          modelIdNormalizationPolicies,
        );
        return id === model.id ? model : { ...model, id };
      });
      if (providerModels.every((model, index) => model === originalModels[index])) {
        return [providerId, providerValue];
      }
      providersChanged = true;
      return [providerId, { ...providerValue, models: providerModels }];
    }),
  );
  return providersChanged ? { ...models, providers } : models;
}

/** Canonicalize model refs submitted through a config mutation API before persistence. */
export function normalizeSubmittedConfigModelRefs(
  cfg: OpenClawConfig,
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): OpenClawConfig {
  let next = cfg;
  const agents = normalizeAgentScopes(cfg.agents);
  if (agents !== cfg.agents) {
    next = { ...next, agents: agents as OpenClawConfig["agents"] };
  }
  const models = normalizeProviderCatalogs(cfg.models, modelIdNormalizationPolicies);
  if (models !== cfg.models) {
    next = { ...next, models: models as OpenClawConfig["models"] };
  }
  // tools.subagents owns only tool policy; model selection moved to
  // agents.defaults/entries.*.subagents.model and the schema rejects the old key.
  return next;
}
