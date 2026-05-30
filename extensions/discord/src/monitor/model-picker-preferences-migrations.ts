import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BundledChannelLegacyStateMigrationDetector } from "openclaw/plugin-sdk/channel-entry-contract";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

const PREFERENCE_MAX_ENTRIES = 2_000;
const MAX_PLUGIN_STATE_KEY_BYTES = 512;
const textEncoder = new TextEncoder();

type LegacyModelPickerPreferencesEntry = {
  recent?: unknown;
  updatedAt?: unknown;
};

type LegacyModelPickerPreferencesStore = {
  entries?: unknown;
};

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readLegacyStore(filePath: string): LegacyModelPickerPreferencesStore | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as LegacyModelPickerPreferencesStore)
      : null;
  } catch {
    return null;
  }
}

function normalizeLegacyPreferenceKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed || textEncoder.encode(trimmed).length > MAX_PLUGIN_STATE_KEY_BYTES) {
    return undefined;
  }
  return trimmed;
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
  return provider && model ? `${provider}/${model}` : null;
}

function sanitizeRecentModels(models: unknown, limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(models)) {
    return deduped;
  }
  for (const item of models) {
    const normalized = normalizeModelRef(typeof item === "string" ? item : undefined);
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

function hashSegment(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function buildPreferenceModelKey(scopeKey: string, modelRef: string): string {
  return `v1:${hashSegment(scopeKey, 32)}:${hashSegment(modelRef, 24)}`;
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function legacyUpdatedAtForIndex(updatedAt: unknown, index: number, total: number): string {
  return new Date(timestampMs(updatedAt) + Math.max(0, total - index)).toISOString();
}

export const detectDiscordLegacyStateMigrations: BundledChannelLegacyStateMigrationDetector = ({
  stateDir,
}) => {
  const sourcePath = path.join(stateDir, "discord", "model-picker-preferences.json");
  if (!fileExists(sourcePath)) {
    return [];
  }
  return [
    {
      kind: "plugin-state-import",
      label: "Discord model picker preferences",
      sourcePath,
      targetPath: "plugin state:model-picker-preferences",
      pluginId: "discord",
      namespace: "model-picker-preferences",
      maxEntries: PREFERENCE_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      readEntries: () => {
        const store = readLegacyStore(sourcePath);
        if (!store || !store.entries || typeof store.entries !== "object") {
          return [];
        }
        const out: Array<{ key: string; value: unknown }> = [];
        for (const [rawKey, rawEntry] of Object.entries(
          store.entries as Record<string, LegacyModelPickerPreferencesEntry>,
        )) {
          const scopeKey = normalizeLegacyPreferenceKey(rawKey);
          if (!scopeKey || !rawEntry || typeof rawEntry !== "object") {
            continue;
          }
          const recent = sanitizeRecentModels(rawEntry.recent, 10);
          for (const [index, modelRef] of recent.entries()) {
            out.push({
              key: buildPreferenceModelKey(scopeKey, modelRef),
              value: {
                scopeKey,
                modelRef,
                updatedAt: legacyUpdatedAtForIndex(rawEntry.updatedAt, index, recent.length),
              },
            });
          }
        }
        return out;
      },
    },
  ];
};
