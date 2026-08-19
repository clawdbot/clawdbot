import { isDeepStrictEqual } from "node:util";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { ensureRecord, getRecord } from "../../../config/legacy.shared.js";
import { normalizeAgentModelRefForConfig } from "../../../config/model-input.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER,
} from "../../../config/model-policy-allowlist-migration.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";

export function hasOwnDefinedProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
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

function modelTable(groups: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(groups).flatMap(([target, models]) =>
      models.split(" ").map((model) => [model, target]),
    ),
  );
}

const RETIRED_GROQ_MODELS = modelTable({
  "llama-3.3-70b-versatile": "deepseek-r1-distill-llama-70b llama3-70b-8192",
  "llama-3.1-8b-instant": "gemma2-9b-it llama3-8b-8192",
  "openai/gpt-oss-120b":
    "meta-llama/llama-4-maverick-17b-128e-instruct moonshotai/kimi-k2-instruct moonshotai/kimi-k2-instruct-0905",
  "qwen/qwen3-32b": "mistral-saba-24b qwen-qwq-32b",
});
const RETIRED_XAI_MODELS = modelTable({
  "grok-build-0.1": "grok-code-fast grok-code-fast-1 grok-code-fast-1-0825",
  "grok-4.3": "grok-4-fast-reasoning grok-4-1-fast-reasoning grok-4-0709",
  "grok-imagine-image-quality": "grok-imagine-image-pro",
});
const RETIRED_OPENAI_MODELS = modelTable({
  "gpt-5.3-codex": "gpt-5.2-codex gpt-5.1-codex gpt-5-codex",
  "gpt-5.5-pro": "gpt-5-pro gpt-5.2-pro",
  "gpt-5.4-nano": "gpt-4.1-nano gpt-5-nano",
  "gpt-5.4-mini": "gpt-4.1-mini gpt-4o-mini gpt-5.1-codex-mini gpt-5-mini",
  "gpt-5.5":
    "gpt-4 gpt-4-turbo gpt-4.1 gpt-4o gpt-4o-2024-05-13 gpt-4o-2024-08-06 gpt-4o-2024-11-20 gpt-5 gpt-5-chat-latest gpt-5.1 gpt-5.1-chat-latest gpt-5.1-codex-max gpt-5.2 gpt-5.2-chat-latest",
});
const RETIRED_CODEX_MODEL_OVERRIDES = modelTable({
  "gpt-5.5": "gpt-5.2 gpt-5.2-codex gpt-5.1-codex gpt-5-codex",
  "gpt-5.4-mini": "gpt-4.1-nano gpt-5-nano",
});

function applyRetiredModelTable(
  normalizedModel: string,
  table: Readonly<Record<string, string>>,
  overrides?: Readonly<Record<string, string>>,
): string | null {
  if (overrides && Object.hasOwn(overrides, normalizedModel)) {
    return overrides[normalizedModel] ?? null;
  }
  return Object.hasOwn(table, normalizedModel) ? (table[normalizedModel] ?? null) : null;
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

const RETIRED_OPUS_ALIASES = new Set("opus-4.5 opus-4.1 opus-4 opus-3".split(" "));
const RETIRED_SONNET_ALIASES = new Set(
  "sonnet-4.5 sonnet-4.1 sonnet-4.0 sonnet-4 sonnet-3.7 sonnet-3.5 sonnet-3 haiku-3.5 haiku-3".split(
    " ",
  ),
);

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
  if (RETIRED_OPUS_ALIASES.has(normalized)) {
    return opusTarget;
  }
  if (RETIRED_SONNET_ALIASES.has(normalized)) {
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

function canonicalizeKnownModelRef(value: string): string | null {
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
  if (normalizedProvider === "openai" && normalizedModel === "gpt-5.6") {
    return `${provider}/gpt-5.6-sol${split.profile ? `@${split.profile}` : ""}`;
  }
  const retiredOwnerModel =
    normalizedProvider === "groq"
      ? applyRetiredModelTable(normalizedModel, RETIRED_GROQ_MODELS)
      : normalizedProvider === "xai"
        ? applyRetiredModelTable(normalizedModel, RETIRED_XAI_MODELS)
        : normalizedProvider === "openai" ||
            normalizedProvider === "openai-codex" ||
            normalizedProvider === "github-copilot"
          ? applyRetiredModelTable(
              normalizedModel,
              RETIRED_OPENAI_MODELS,
              normalizedProvider === "openai-codex" ? RETIRED_CODEX_MODEL_OVERRIDES : undefined,
            )
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

function normalizeKnownModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return value === trimmed ? null : trimmed;
  }
  const split = splitTrailingAuthProfile(trimmed);
  const slash = split.model.indexOf("/");
  const provider = slash > 0 ? normalizeString(split.model.slice(0, slash)) : "";
  const modelId = slash > 0 ? split.model.slice(slash + 1) : split.model;
  const normalizedModel =
    provider === "google" ||
    provider === "google-gemini-cli" ||
    provider === "google-vertex" ||
    provider === "together" ||
    normalizeString(modelId).startsWith("google/")
      ? normalizeAgentModelRefForConfig(split.model)
      : split.model;
  const normalized = `${normalizedModel}${split.profile ? `@${split.profile}` : ""}`;
  return canonicalizeKnownModelRef(normalized) ?? (normalized === value ? null : normalized);
}

const MODEL_REF_STRING_KEYS = new Set([
  "model",
  "primary",
  "summaryModel",
  "imageModel",
  "utilityModel",
  "voiceModel",
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

function isMediaModelPath(path: string): boolean {
  return ["image", "video", "music"].includes(pathKey(path)) && path.includes(".mediaModels.");
}

function isProviderCatalogsPath(path: string): boolean {
  return path === ".providers" || path.endsWith(".models.providers");
}

function normalizeProviderCatalogModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  const normalizedProvider = normalizeString(provider);
  const normalized =
    normalizedProvider === "google" ||
    normalizedProvider === "google-gemini-cli" ||
    normalizedProvider === "google-vertex" ||
    normalizedProvider === "together" ||
    normalizeString(trimmed).startsWith("google/")
      ? normalizeConfiguredProviderCatalogModelId(provider, trimmed)
      : trimmed;
  const upgradedRef = canonicalizeKnownModelRef(`${provider}/${normalized}`);
  if (!upgradedRef) {
    return normalized;
  }
  const slash = upgradedRef.indexOf("/");
  return slash > 0 && normalizeString(upgradedRef.slice(0, slash)) === normalizeString(provider)
    ? upgradedRef.slice(slash + 1)
    : normalized;
}

function scanProviderCatalogModelIds(providers: Record<string, unknown>): boolean {
  return Object.entries(providers).some(([providerId, providerValue]) => {
    const models = getRecord(providerValue)?.models;
    return (
      Array.isArray(models) &&
      models.some((model) => {
        const modelId = getRecord(model)?.id;
        return (
          typeof modelId === "string" &&
          normalizeProviderCatalogModelId(providerId, modelId) !== modelId
        );
      })
    );
  });
}

export function scanKnownModelRefs(value: unknown, key?: string, path = ""): boolean {
  if (typeof value === "string") {
    return Boolean(
      key &&
      (MODEL_REF_STRING_KEYS.has(key) ||
        isChannelModelOverridePath(path) ||
        isMediaModelPath(path)) &&
      normalizeKnownModelRef(value),
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry, index) =>
      typeof entry === "string" &&
      key &&
      (MODEL_REF_ARRAY_KEYS.has(key) || isModelPolicyAllowPath(path))
        ? Boolean(normalizeKnownModelRef(entry))
        : scanKnownModelRefs(entry, undefined, `${path}.${index}`),
    );
  }
  const record = getRecord(value);
  if (!record) {
    return false;
  }
  if (isProviderCatalogsPath(path) && scanProviderCatalogModelIds(record)) {
    return true;
  }
  if (key && MODEL_REF_MAP_KEYS.has(key)) {
    return Object.keys(record).some((entryKey) => Boolean(normalizeKnownModelRef(entryKey)));
  }
  return Object.entries(record).some(([childKey, child]) =>
    scanKnownModelRefs(child, childKey, `${path}.${childKey}`),
  );
}

export function collectLegacyDefaultModelAllowRefs(raw: Record<string, unknown>): string[] | null {
  // Marker seeding at the config write boundary ships atomically with metadata-only
  // model maps. Therefore an unmarked map is legacy even if a general write version advanced.
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  return computeModelPolicyAllowlist({
    root: raw,
    defaults,
  });
}

export function migrateExplicitDefaultModelAllowPolicy(
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
  const upgraded = normalizeKnownModelRef(value);
  if (!upgraded) {
    return value;
  }
  changes.push(`Upgraded ${path} from ${JSON.stringify(value)} to ${JSON.stringify(upgraded)}.`);
  return upgraded;
}

export function setRecordEntry(record: Record<string, unknown>, key: string, value: unknown): void {
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
    const upgradedKey = normalizeKnownModelRef(key);
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

type ProviderCatalogModelRow = {
  index: number;
  model: unknown;
  modelRecord?: Record<string, unknown>;
  originalId?: string;
  normalizedId?: string;
  changed?: boolean;
};

function rewriteProviderCatalogModelIds(
  providers: Record<string, unknown>,
  path: string,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...providers };
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    if (!provider || !Array.isArray(provider.models)) {
      continue;
    }
    const rows: ProviderCatalogModelRow[] = provider.models.map((model, index) => {
      const modelRecord = getRecord(model);
      if (!modelRecord || typeof modelRecord.id !== "string") {
        return { index, model };
      }
      const normalizedId = normalizeProviderCatalogModelId(providerId, modelRecord.id);
      return {
        index,
        model,
        modelRecord,
        originalId: modelRecord.id,
        normalizedId,
        changed: normalizedId !== modelRecord.id,
      };
    });
    if (!rows.some((row) => row.changed)) {
      continue;
    }

    const rowsById = new Map<string, typeof rows>();
    for (const row of rows) {
      if (row.normalizedId === undefined) {
        continue;
      }
      const grouped = rowsById.get(row.normalizedId) ?? [];
      grouped.push(row);
      rowsById.set(row.normalizedId, grouped);
    }
    const emittedIds = new Set<string>();
    const models: unknown[] = [];
    for (const row of rows) {
      if (row.normalizedId === undefined || row.modelRecord === undefined) {
        models.push(row.model);
        continue;
      }
      const grouped = rowsById.get(row.normalizedId) ?? [row];
      if (!grouped.some((candidate) => candidate.changed)) {
        models.push(row.model);
        continue;
      }
      if (emittedIds.has(row.normalizedId)) {
        continue;
      }
      emittedIds.add(row.normalizedId);

      const preferred =
        grouped.find((candidate) => candidate.originalId === candidate.normalizedId) ?? grouped[0];
      const preferredRecord = preferred?.modelRecord;
      if (!preferred || !preferredRecord) {
        models.push(row.model);
        continue;
      }
      let merged: Record<string, unknown> = { ...preferredRecord, id: row.normalizedId };
      for (const candidate of grouped) {
        if (candidate === preferred || !candidate.modelRecord) {
          continue;
        }
        const result = mergeModelRefMapEntries(
          merged,
          { ...candidate.modelRecord, id: row.normalizedId },
          `${path}.${providerId}.models.${preferred.index}`,
        );
        merged = getRecord(result.value) ?? merged;
        changes.push(
          result.conflicts.length > 0
            ? `Merged ${path}.${providerId}.models.${candidate.index} into model id ${JSON.stringify(row.normalizedId)}; kept canonical values for conflicting fields: ${result.conflicts.toSorted().join(", ")}.`
            : `Merged ${path}.${providerId}.models.${candidate.index} into model id ${JSON.stringify(row.normalizedId)}.`,
        );
      }
      for (const candidate of grouped) {
        if (!candidate.changed) {
          continue;
        }
        changes.push(
          `Upgraded ${path}.${providerId}.models.${candidate.index}.id from ${JSON.stringify(candidate.originalId)} to ${JSON.stringify(candidate.normalizedId)}.`,
        );
      }
      models.push(merged);
    }
    next[providerId] = { ...provider, models };
    changed = true;
  }
  return { value: changed ? next : providers, changed };
}

export function rewriteKnownModelRefs(
  value: unknown,
  path: string,
  changes: string[],
): { value: unknown; changed: boolean } {
  const key = pathKey(path);
  if (typeof value === "string") {
    if (
      !MODEL_REF_STRING_KEYS.has(key) &&
      !isChannelModelOverridePath(path) &&
      !isMediaModelPath(path)
    ) {
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
  if (isProviderCatalogsPath(path)) {
    const rewrittenCatalogs = rewriteProviderCatalogModelIds(record, path, changes);
    working = rewrittenCatalogs.value;
    changed ||= rewrittenCatalogs.changed;
  }
  if (MODEL_REF_MAP_KEYS.has(key)) {
    const rewrittenKeys = rewriteModelRefMapKeys(working, path, changes);
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

export const MODEL_REF_CANONICALIZATION_MESSAGE =
  'Configured retired or noncanonical model refs are no longer in the bundled catalogs; run "openclaw doctor --fix" to upgrade them.';
