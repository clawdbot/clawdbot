import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { normalizeProviderId } from "../../../agents/provider-id.js";
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";

const STALE_CONTEXT_WINDOW_FIXES: Record<string, { stale: number; correct: number }> = {
  "deepseek/deepseek-v4-flash": { stale: 200_000, correct: 1_000_000 },
} as const;

function resolveStaleContextWindowFix(params: {
  providerId: string;
  modelId: string;
  contextWindow: number;
}): { stale: number; correct: number } | undefined {
  if (params.providerId !== "deepseek") {
    return undefined;
  }
  const scopedModelId = params.modelId.includes("/")
    ? params.modelId
    : `deepseek/${params.modelId}`;
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
    if (Object.prototype.hasOwnProperty.call(params, key)) {
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
      return "grok-4.3";
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
      typeof entry === "string" && key && MODEL_REF_ARRAY_KEYS.has(key)
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

function rewriteModelRefString(value: string, path: string, changes: string[]): string {
  const upgraded = upgradeRetiredModelRef(value);
  if (!upgraded) {
    return value;
  }
  changes.push(`Upgraded ${path} from ${JSON.stringify(value)} to ${JSON.stringify(upgraded)}.`);
  return upgraded;
}

function rewriteModelRefMapKeys(
  record: Record<string, unknown>,
  path: string,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const upgradedKey = upgradeRetiredModelRef(key);
    const nextKey = upgradedKey ?? key;
    if (upgradedKey) {
      changes.push(
        `Upgraded ${path} key from ${JSON.stringify(key)} to ${JSON.stringify(upgradedKey)}.`,
      );
      changed = true;
    }
    if (nextKey in next && upgradedKey) {
      continue;
    }
    next[nextKey] = child;
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
      if (typeof entry === "string" && MODEL_REF_ARRAY_KEYS.has(key)) {
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
    next[childKey] = rewritten.value;
  }
  return { value: changed ? next : value, changed };
}

const RETIRED_MODEL_REF_MESSAGE =
  'Configured retired model refs are no longer in the bundled catalogs; run "openclaw doctor --fix" to upgrade them.';
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

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "models.retired-model-refs",
    describe: "Upgrade retired model refs to current catalog entries",
    legacyRules: RETIRED_MODEL_REF_RULES,
    apply: (raw, changes) => {
      const rewritten = rewriteKnownModelRefs(raw, "config", changes);
      if (!rewritten.changed || !getRecord(rewritten.value)) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, rewritten.value);
    },
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
