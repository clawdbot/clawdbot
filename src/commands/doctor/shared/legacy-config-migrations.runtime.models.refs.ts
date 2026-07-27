import { isDeepStrictEqual } from "node:util";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { ensureRecord, getRecord } from "../../../config/legacy.shared.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER,
} from "../../../config/model-policy-allowlist-migration.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";

export function hasOwnDefinedProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

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

export function scanKnownModelRefs(value: unknown, key?: string, path = ""): boolean {
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
  const upgraded = upgradeRetiredModelRef(value);
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

export function rewriteKnownModelRefs(
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

export const RETIRED_MODEL_REF_MESSAGE =
  'Configured retired model refs are no longer in the bundled catalogs; run "openclaw doctor --fix" to upgrade them.';
