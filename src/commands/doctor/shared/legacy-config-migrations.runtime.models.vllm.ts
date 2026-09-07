import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { ensureRecord, getRecord, type LegacyConfigRule } from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
import {
  hasInvalidThinkingFormat,
  hasStaleContextWindowValue,
} from "./legacy-config-migrations.runtime.models.catalog.js";
import { visitAgentEntries } from "./legacy-config-record-shared.js";

const QWEN_THINKING_FORMAT_KEYS = ["qwenThinkingFormat", "qwen_thinking_format"] as const;

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

export function getLegacyVllmQwenThinkingFormat(params: Record<string, unknown>):
  | {
      key: (typeof QWEN_THINKING_FORMAT_KEYS)[number];
      value: unknown;
      compat: "qwen" | "qwen-chat-template" | undefined;
    }
  | undefined {
  for (const key of QWEN_THINKING_FORMAT_KEYS) {
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

export function parseVllmAgentModelKey(key: string): string | undefined {
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
  let found = false;
  visitAgentEntries({ agents }, (agent) => {
    found ||= hasLegacyVllmQwenThinkingParams(agent.params);
  });
  return found;
}

export function findOrCreateVllmModelEntry(
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

export function listExistingVllmModelTargets(
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

export function collectVllmModelIdsFromSelection(value: unknown): string[] {
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

export function collectVllmModelIdsFromAgentModelMap(value: unknown): string[] {
  const models = getRecord(value);
  if (!models) {
    return [];
  }
  return Object.keys(models).flatMap((key) => {
    const modelId = parseVllmAgentModelKey(key);
    return modelId ? [modelId] : [];
  });
}

export function createVllmModelTargets(
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

export function combineVllmModelTargets(
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

export function collectVllmModelIdsFromAgentRoster(raw: Record<string, unknown>): string[] {
  const modelIds: string[] = [];
  visitAgentEntries(raw, (agent) => {
    modelIds.push(
      ...collectVllmModelIdsFromSelection(agent.model),
      ...collectVllmModelIdsFromAgentModelMap(agent.models),
    );
  });
  return modelIds;
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

export function findVllmProvider(
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
  for (const key of QWEN_THINKING_FORMAT_KEYS) {
    delete params[key];
  }
}

export function applyLegacyVllmQwenThinkingFormat(params: {
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

export function removeUntargetedLegacyVllmQwenThinkingFormat(params: {
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

export const LEGACY_VLLM_QWEN_AGENT_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["agents", "defaults", "models"],
  message:
    'agents.defaults.models.<vllm-model>.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingFormat(value),
};

export const LEGACY_VLLM_QWEN_PROVIDER_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers", "vllm", "params"],
  message:
    'models.providers.vllm.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingProviderParams({ params: value }),
};

export const LEGACY_VLLM_QWEN_PROVIDER_MODEL_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers", "vllm", "models"],
  message:
    'models.providers.vllm.models[*].params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingModelParams({ models: value }),
};

export const LEGACY_VLLM_QWEN_NORMALIZED_PROVIDER_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<vllm>.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.<vllm>.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingNormalizedProvider(value),
};

export const LEGACY_VLLM_QWEN_DEFAULT_PARAMS_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["agents", "defaults", "params"],
  message:
    'agents.defaults.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingParams(value),
};

export const LEGACY_VLLM_QWEN_AGENT_PARAMS_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["agents"],
  message:
    'agents.entries.*.params.qwenThinkingFormat is legacy; run "openclaw doctor --fix" to move it to models.providers.vllm.models[].compat.thinkingFormat.',
  match: (value) => hasLegacyVllmQwenThinkingAgentParams(value),
};

export const INVALID_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].compat.thinkingFormat has an unrecognized value; run "openclaw doctor --fix" to remove it and restore the runtime default.',
  match: (value) => hasInvalidThinkingFormat(value),
};

export const STALE_CONTEXT_WINDOW_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].contextWindow has a stale catalog value; run "openclaw doctor --fix" to repair it.',
  match: (value) => hasStaleContextWindowValue(value),
};
