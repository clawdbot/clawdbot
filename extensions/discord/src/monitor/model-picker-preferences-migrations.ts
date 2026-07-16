// Discord plugin module implements model picker preferences migrations behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import type { BundledChannelLegacyStateMigrationDetector } from "openclaw/plugin-sdk/channel-entry-contract";
import { MAX_DATE_TIMESTAMP_MS, timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES,
  DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE,
} from "../command-deploy-store.js";
import {
  normalizePersistedBinding,
  THREAD_BINDINGS_MAX_ENTRIES,
  THREAD_BINDINGS_NAMESPACE,
  toBindingRecordKey,
} from "./thread-bindings.state.js";

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

type LegacyThreadBindingsStore = {
  version?: unknown;
  bindings?: unknown;
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

function readLegacyThreadBindingsStore(filePath: string): LegacyThreadBindingsStore {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("legacy Discord thread bindings store must be an object");
  }
  return parsed as LegacyThreadBindingsStore;
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
  const baseMs = timestampMs(updatedAt);
  const anchorMs = Math.min(baseMs + Math.max(0, total), MAX_DATE_TIMESTAMP_MS);
  const shiftedMs = anchorMs - Math.max(0, index);
  return (
    timestampMsToIsoString(shiftedMs) ??
    timestampMsToIsoString(baseMs) ??
    timestampMsToIsoString(Math.max(0, total - index)) ??
    "1970-01-01T00:00:00.000Z"
  );
}

function readFiniteNumberField(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

// Doctor-owned legacy-shape repair: pre-account-scoped stores carried a flat
// `sessionKey` alias and an absolute `expiresAt`. Runtime normalization reads
// canonical fields only, so the one-time JSON import maps them here.
function upgradeLegacyThreadBindingShape(rawEntry: unknown): unknown {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return rawEntry;
  }
  const entry = { ...(rawEntry as Record<string, unknown>) };
  if (entry.targetSessionKey === undefined && typeof entry.sessionKey === "string") {
    entry.targetSessionKey = entry.sessionKey;
  }
  delete entry.sessionKey;
  const expiresAt = readFiniteNumberField(entry, "expiresAt");
  delete entry.expiresAt;
  if (
    entry.idleTimeoutMs === undefined &&
    entry.maxAgeMs === undefined &&
    expiresAt !== undefined
  ) {
    // Legacy expiresAt was an absolute timestamp; map it to max-age and disable idle timeout.
    entry.idleTimeoutMs = 0;
    if (expiresAt <= 0) {
      entry.maxAgeMs = 0;
    } else {
      const boundAt = readFiniteNumberField(entry, "boundAt") ?? 0;
      const lastActivityAt = readFiniteNumberField(entry, "lastActivityAt") ?? 0;
      const base = boundAt > 0 ? boundAt : lastActivityAt;
      entry.maxAgeMs = Math.max(1, expiresAt - Math.max(0, base));
    }
  }
  return entry;
}

export const detectDiscordLegacyStateMigrations: BundledChannelLegacyStateMigrationDetector = ({
  stateDir,
}) => {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  const commandDeployCacheSourcePath = path.join(stateDir, "discord", "command-deploy-cache.json");
  if (fileExists(commandDeployCacheSourcePath)) {
    plans.push({
      kind: "plugin-state-import",
      label: "Discord command deployment cache",
      sourcePath: commandDeployCacheSourcePath,
      targetPath: `plugin state:${DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE}`,
      pluginId: "discord",
      namespace: DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE,
      maxEntries: DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "remove",
      cleanupWhenEmpty: true,
      // Rebuildable cache: discard file-era hashes and reconcile once against Discord.
      readEntries: () => [],
    });
  }
  const modelPickerSourcePath = path.join(stateDir, "discord", "model-picker-preferences.json");
  if (fileExists(modelPickerSourcePath)) {
    plans.push({
      kind: "plugin-state-import",
      label: "Discord model picker preferences",
      sourcePath: modelPickerSourcePath,
      targetPath: "plugin state:model-picker-preferences",
      pluginId: "discord",
      namespace: "model-picker-preferences",
      maxEntries: PREFERENCE_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      readEntries: () => {
        const store = readLegacyStore(modelPickerSourcePath);
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
    });
  }

  const threadBindingsSourcePath = path.join(stateDir, "discord", "thread-bindings.json");
  if (fileExists(threadBindingsSourcePath)) {
    plans.push({
      kind: "plugin-state-import",
      label: "Discord thread bindings",
      sourcePath: threadBindingsSourcePath,
      targetPath: `plugin state:${THREAD_BINDINGS_NAMESPACE}`,
      pluginId: "discord",
      namespace: THREAD_BINDINGS_NAMESPACE,
      maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      cleanupWhenEmpty: true,
      readEntries: () => {
        const store = readLegacyThreadBindingsStore(threadBindingsSourcePath);
        if (store?.version !== 1 || !store.bindings || typeof store.bindings !== "object") {
          throw new Error("legacy Discord thread bindings store must have version 1 bindings");
        }
        const out: Array<{ key: string; value: unknown }> = [];
        for (const [rawKey, rawEntry] of Object.entries(
          store.bindings as Record<string, unknown>,
        )) {
          const normalized = normalizePersistedBinding(
            rawKey,
            upgradeLegacyThreadBindingShape(rawEntry),
          );
          if (normalized) {
            out.push({
              key: toBindingRecordKey(normalized),
              value: normalized,
            });
          }
        }
        return out;
      },
    });
  }

  return plans;
};
