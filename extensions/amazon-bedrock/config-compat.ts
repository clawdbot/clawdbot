import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type JsonRecord = Record<string, unknown>;

const LEGACY_PATH = "models.bedrockDiscovery";
const TARGET_PATH = "plugins.entries.amazon-bedrock.config.discovery";
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isBlockedObjectKey(key: string): boolean {
  return BLOCKED_OBJECT_KEYS.has(key);
}

function getRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function ensureRecord(root: JsonRecord, key: string): JsonRecord {
  const existing = root[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: JsonRecord = {};
  root[key] = next;
  return next;
}

function mergeMissing(target: JsonRecord, source: JsonRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
}

function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

function resolveLegacyBedrockDiscoveryConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const models = getRecord(raw.models);
  return getRecord(models?.bedrockDiscovery) ?? undefined;
}

function pruneEmptyModelsRoot(root: JsonRecord): void {
  const models = getRecord(root.models);
  if (models && Object.keys(models).length === 0) {
    delete root.models;
  }
}

export function migrateAmazonBedrockLegacyConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }

  const legacy = resolveLegacyBedrockDiscoveryConfig(raw);
  if (!legacy) {
    return { config: raw, changes: [] };
  }

  const nextRoot = structuredClone(raw) as JsonRecord;
  const models = ensureRecord(nextRoot, "models");
  delete models.bedrockDiscovery;
  pruneEmptyModelsRoot(nextRoot);

  const changes: string[] = [];
  if (Object.keys(legacy).length === 0) {
    changes.push(`Removed empty ${LEGACY_PATH}.`);
    return { config: nextRoot as T, changes };
  }

  const plugins = ensureRecord(nextRoot, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, "amazon-bedrock");
  const config = ensureRecord(entry, "config");
  const existing = getRecord(config.discovery) ?? undefined;

  if (!existing) {
    config.discovery = cloneRecord(legacy);
    changes.push(`Moved ${LEGACY_PATH} → ${TARGET_PATH}.`);
    return { config: nextRoot as T, changes };
  }

  const merged = cloneRecord(existing);
  mergeMissing(merged, legacy);
  config.discovery = merged;
  if (JSON.stringify(merged) !== JSON.stringify(existing)) {
    changes.push(
      `Merged ${LEGACY_PATH} → ${TARGET_PATH} (filled missing fields from legacy; kept explicit plugin config values).`,
    );
    return { config: nextRoot as T, changes };
  }

  changes.push(`Removed ${LEGACY_PATH} (${TARGET_PATH} already set).`);
  return { config: nextRoot as T, changes };
}
