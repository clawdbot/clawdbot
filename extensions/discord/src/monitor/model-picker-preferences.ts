import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId as normalizeSharedAccountId } from "openclaw/plugin-sdk/account-id";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";

const DEFAULT_RECENT_LIMIT = 5;
const PREFERENCE_MAX_ENTRIES = 2_000;
const MAX_PLUGIN_STATE_KEY_BYTES = 512;
const textEncoder = new TextEncoder();
let lastPreferenceTimestampMs = 0;

type ModelPickerPreferencesEntry = {
  scopeKey: string;
  modelRef: string;
  updatedAt: string;
};

type LegacyModelPickerPreferencesEntry = {
  recent: string[];
  updatedAt: string;
};

type LegacyModelPickerPreferencesStore = {
  version?: unknown;
  entries?: unknown;
};

const legacyPreferenceImports = new Map<string, Promise<void>>();

function openPreferenceStore(env?: NodeJS.ProcessEnv) {
  return getDiscordRuntime().state.openKeyedStore<ModelPickerPreferencesEntry>({
    namespace: "model-picker-preferences",
    maxEntries: PREFERENCE_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

export type DiscordModelPickerPreferenceScope = {
  accountId?: string;
  guildId?: string;
  userId: string;
};

function normalizeId(value?: string): string {
  return normalizeOptionalString(value) ?? "";
}

export function buildDiscordModelPickerPreferenceKey(
  scope: DiscordModelPickerPreferenceScope,
): string | null {
  const userId = normalizeId(scope.userId);
  if (!userId) {
    return null;
  }
  const accountId = normalizeSharedAccountId(scope.accountId);
  const guildId = normalizeId(scope.guildId);
  if (guildId) {
    return `discord:${accountId}:guild:${guildId}:user:${userId}`;
  }
  return `discord:${accountId}:dm:user:${userId}`;
}

function normalizeModelRef(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= value.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(value.slice(0, slashIndex));
  const model = value.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return `${provider}/${model}`;
}

function sanitizeRecentModels(models: string[] | undefined, limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of models ?? []) {
    const normalized = normalizeModelRef(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

function sanitizeLegacyPreferenceEntry(
  value: unknown,
): LegacyModelPickerPreferencesEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const typedValue = value as {
    recent?: unknown;
    updatedAt?: unknown;
  };
  const recent = Array.isArray(typedValue.recent)
    ? typedValue.recent.filter((item: unknown): item is string => typeof item === "string")
    : [];
  const updatedAt = typeof typedValue.updatedAt === "string" ? typedValue.updatedAt : "";
  return { recent, updatedAt };
}

function sanitizeStoredPreferenceEntry(value: unknown): ModelPickerPreferencesEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const typedValue = value as {
    scopeKey?: unknown;
    modelRef?: unknown;
    updatedAt?: unknown;
  };
  if (typeof typedValue.scopeKey !== "string" || typeof typedValue.modelRef !== "string") {
    return undefined;
  }
  const modelRef = normalizeModelRef(typedValue.modelRef);
  if (!modelRef) {
    return undefined;
  }
  return {
    scopeKey: typedValue.scopeKey,
    modelRef,
    updatedAt: typeof typedValue.updatedAt === "string" ? typedValue.updatedAt : "",
  };
}

function hashSegment(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function buildPreferenceModelKey(scopeKey: string, modelRef: string): string {
  return `v1:${hashSegment(scopeKey, 32)}:${hashSegment(modelRef, 24)}`;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function legacyUpdatedAtForIndex(updatedAt: string, index: number, total: number): string {
  return new Date(timestampMs(updatedAt) + Math.max(0, total - index)).toISOString();
}

function nextPreferenceTimestampIso(): string {
  lastPreferenceTimestampMs = Math.max(Date.now(), lastPreferenceTimestampMs + 1);
  return new Date(lastPreferenceTimestampMs).toISOString();
}

function normalizeLegacyPreferenceKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed || textEncoder.encode(trimmed).length > MAX_PLUGIN_STATE_KEY_BYTES) {
    return undefined;
  }
  return trimmed;
}

function resolveLegacyPreferencesPath(env?: NodeJS.ProcessEnv): string {
  return path.join(
    resolveStateDir(env ?? process.env, os.homedir),
    "discord",
    "model-picker-preferences.json",
  );
}

async function importLegacyPreferences(env?: NodeJS.ProcessEnv): Promise<void> {
  const legacyPath = resolveLegacyPreferencesPath(env);
  const stateDir = path.dirname(path.dirname(legacyPath));
  const existingImport = legacyPreferenceImports.get(stateDir);
  if (existingImport) {
    await existingImport;
    return;
  }

  const importPromise = (async () => {
    const { value, exists } =
      await readJsonFileWithFallback<LegacyModelPickerPreferencesStore | null>(legacyPath, null);
    if (!exists || !value || typeof value.entries !== "object" || value.entries == null) {
      return;
    }

    const store = openPreferenceStore(env);
    for (const [rawKey, rawEntry] of Object.entries(value.entries as Record<string, unknown>)) {
      const key = normalizeLegacyPreferenceKey(rawKey);
      if (!key) {
        continue;
      }
      const entry = sanitizeLegacyPreferenceEntry(rawEntry);
      if (!entry || (entry.recent.length === 0 && !entry.updatedAt)) {
        continue;
      }
      const recent = sanitizeRecentModels(entry.recent, 10);
      for (const [index, modelRef] of recent.entries()) {
        await store.registerIfAbsent(buildPreferenceModelKey(key, modelRef), {
          scopeKey: key,
          modelRef,
          updatedAt: legacyUpdatedAtForIndex(entry.updatedAt, index, recent.length),
        });
      }
    }
  })();
  legacyPreferenceImports.set(stateDir, importPromise);
  try {
    await importPromise;
  } catch (error) {
    legacyPreferenceImports.delete(stateDir);
    throw error;
  }
}

export async function readDiscordModelPickerRecentModels(params: {
  scope: DiscordModelPickerPreferenceScope;
  limit?: number;
  allowedModelRefs?: Set<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  if (!key) {
    return [];
  }
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  try {
    await importLegacyPreferences(params.env);
    const store = openPreferenceStore(params.env);
    const recent = (await store.entries())
      .map((entry) => sanitizeStoredPreferenceEntry(entry.value))
      .filter((entry): entry is ModelPickerPreferencesEntry => entry?.scopeKey === key)
      .toSorted((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt))
      .map((entry) => entry.modelRef);
    if (!params.allowedModelRefs || params.allowedModelRefs.size === 0) {
      return sanitizeRecentModels(recent, limit);
    }
    return sanitizeRecentModels(
      recent.filter((modelRef) => params.allowedModelRefs?.has(modelRef)),
      limit,
    );
  } catch {
    return [];
  }
}

export async function recordDiscordModelPickerRecentModel(params: {
  scope: DiscordModelPickerPreferenceScope;
  modelRef: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  const normalizedModelRef = normalizeModelRef(params.modelRef);
  if (!key || !normalizedModelRef) {
    return;
  }

  try {
    await importLegacyPreferences(params.env);
    const store = openPreferenceStore(params.env);
    await store.register(buildPreferenceModelKey(key, normalizedModelRef), {
      scopeKey: key,
      modelRef: normalizedModelRef,
      updatedAt: nextPreferenceTimestampIso(),
    });
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
    const scopedEntries = (await store.entries())
      .map((entry) => ({ key: entry.key, value: sanitizeStoredPreferenceEntry(entry.value) }))
      .filter(
        (entry): entry is { key: string; value: ModelPickerPreferencesEntry } =>
          entry.value?.scopeKey === key,
      )
      .toSorted(
        (left, right) =>
          timestampMs(right.value.updatedAt) - timestampMs(left.value.updatedAt) ||
          left.key.localeCompare(right.key),
      );
    await Promise.all(scopedEntries.slice(limit).map((entry) => store.delete(entry.key)));
  } catch {
    return;
  }
}
