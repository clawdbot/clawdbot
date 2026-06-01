import { createHash } from "node:crypto";
import { normalizeAccountId as normalizeSharedAccountId } from "openclaw/plugin-sdk/account-id";
import {
  MAX_DATE_TIMESTAMP_MS,
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";

const DEFAULT_RECENT_LIMIT = 5;
const PREFERENCE_MAX_ENTRIES = 2_000;
let lastPreferenceTimestampMs = 0;
let lastPreferenceOrder = 0;

type ModelPickerPreferencesEntry = {
  scopeKey: string;
  modelRef: string;
  updatedAt: string;
  updatedOrder?: number;
};

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

function sanitizeStoredPreferenceEntry(value: unknown): ModelPickerPreferencesEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const typedValue = value as {
    scopeKey?: unknown;
    modelRef?: unknown;
    updatedAt?: unknown;
    updatedOrder?: unknown;
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
    updatedOrder:
      typeof typedValue.updatedOrder === "number" && Number.isSafeInteger(typedValue.updatedOrder)
        ? typedValue.updatedOrder
        : undefined,
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

function timestampOrder(value?: number): number {
  return value !== undefined && value >= 0 ? value : 0;
}

function comparePreferenceEntries(
  left: { key: string; value: ModelPickerPreferencesEntry },
  right: { key: string; value: ModelPickerPreferencesEntry },
): number {
  return (
    timestampMs(right.value.updatedAt) - timestampMs(left.value.updatedAt) ||
    timestampOrder(right.value.updatedOrder) - timestampOrder(left.value.updatedOrder) ||
    left.key.localeCompare(right.key)
  );
}

function nextPreferenceTimestamp(existingEntries: ModelPickerPreferencesEntry[]): {
  updatedAt: string;
  updatedOrder: number;
} {
  const existingMaxTimestampMs = existingEntries.reduce(
    (max, entry) => Math.max(max, timestampMs(entry.updatedAt)),
    0,
  );
  lastPreferenceTimestampMs = Math.min(
    Math.max(
      resolveDateTimestampMs(Date.now(), 0),
      lastPreferenceTimestampMs + 1,
      existingMaxTimestampMs + 1,
    ),
    MAX_DATE_TIMESTAMP_MS,
  );
  const existingMaxOrder = existingEntries.reduce(
    (max, entry) => Math.max(max, timestampOrder(entry.updatedOrder)),
    0,
  );
  lastPreferenceOrder = Math.max(lastPreferenceOrder + 1, existingMaxOrder + 1);
  return {
    updatedAt: resolveTimestampMsToIsoString(lastPreferenceTimestampMs),
    updatedOrder: lastPreferenceOrder,
  };
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
    const store = openPreferenceStore(params.env);
    const recent = (await store.entries())
      .map((entry) => ({ key: entry.key, value: sanitizeStoredPreferenceEntry(entry.value) }))
      .filter(
        (entry): entry is { key: string; value: ModelPickerPreferencesEntry } =>
          entry.value?.scopeKey === key,
      )
      .toSorted(comparePreferenceEntries)
      .map((entry) => entry.value.modelRef);
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
    const store = openPreferenceStore(params.env);
    const existingEntries = (await store.entries())
      .map((entry) => sanitizeStoredPreferenceEntry(entry.value))
      .filter((entry): entry is ModelPickerPreferencesEntry => entry?.scopeKey === key);
    const timestamp = nextPreferenceTimestamp(existingEntries);
    await store.register(buildPreferenceModelKey(key, normalizedModelRef), {
      scopeKey: key,
      modelRef: normalizedModelRef,
      ...timestamp,
    });
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
    const scopedEntries = (await store.entries())
      .map((entry) => ({ key: entry.key, value: sanitizeStoredPreferenceEntry(entry.value) }))
      .filter(
        (entry): entry is { key: string; value: ModelPickerPreferencesEntry } =>
          entry.value?.scopeKey === key,
      )
      .toSorted(comparePreferenceEntries);
    await Promise.all(scopedEntries.slice(limit).map((entry) => store.delete(entry.key)));
  } catch {}
}
