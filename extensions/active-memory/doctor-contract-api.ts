/**
 * Doctor migration contract for Active Memory state. It moves legacy per-session
 * toggle JSON into the plugin state keyed store used by current runtimes.
 */
import crypto from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineLegacyJsonStateMigration,
  LEGACY_JSON_MIGRATION_MAX_BYTES,
  LEGACY_JSON_MIGRATION_RECOVERY_MAX_BYTES,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: boolean;
  updatedAt: number;
};

const TOGGLE_STATE_FILE = "session-toggles.json";
const SESSION_TOGGLES_NAMESPACE = "session-toggles";
const MAX_TOGGLE_ENTRIES = 10_000;
const RETIRED_QMD_CONFIG_PATH = ["plugins", "entries", "active-memory", "config", "qmd"];

export const LEGACY_TOGGLE_STATE_MAX_BYTES = LEGACY_JSON_MIGRATION_MAX_BYTES;
export const LEGACY_TOGGLE_RECOVERY_MAX_BYTES = LEGACY_JSON_MIGRATION_RECOVERY_MAX_BYTES;

/** Retired Active Memory QMD override detected before strict manifest validation. */
export const legacyConfigRules = [
  {
    path: RETIRED_QMD_CONFIG_PATH,
    message:
      'plugins.entries.active-memory.config.qmd is retired because the QMD memory backend was removed. Run "openclaw doctor --fix".',
  },
];

/** Removes the retired plugin-owned QMD override. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.["active-memory"]);
  const pluginConfig = asObjectRecord(entry?.config);
  if (!pluginConfig || !Object.hasOwn(pluginConfig, "qmd")) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.["active-memory"]);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  delete nextPluginConfig.qmd;
  return {
    config: nextConfig,
    changes: ["Removed retired Active Memory QMD search-mode configuration."],
  };
}

function resolveToggleStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "active-memory", TOGGLE_STATE_FILE);
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function normalizeLegacyUpdatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

/**
 * Parses legacy toggle JSON with tolerant per-record semantics: malformed
 * records are skipped, non-true disabled values are ignored, and invalid
 * timestamps are normalized.
 */
function parseLegacyToggleEntries(parsed: unknown): ActiveMemoryToggleEntry[] {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    return [];
  }
  const entries: ActiveMemoryToggleEntry[] = [];
  for (const [sessionKey, value] of Object.entries(sessions)) {
    if (!sessionKey.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if ((value as { disabled?: unknown }).disabled !== true) {
      continue;
    }
    const updatedAt = normalizeLegacyUpdatedAt((value as { updatedAt?: unknown }).updatedAt);
    entries.push({ sessionKey, disabled: true, updatedAt });
  }
  return entries;
}

/** State migrations exposed to OpenClaw doctor for Active Memory. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  defineLegacyJsonStateMigration<ActiveMemoryToggleEntry[]>({
    id: "active-memory-session-toggles-json-to-plugin-state",
    label: "Active Memory session toggles",
    resolvePath: resolveToggleStatePath,
    parse: parseLegacyToggleEntries,
    namespace: SESSION_TOGGLES_NAMESPACE,
    maxEntries: MAX_TOGGLE_ENTRIES,
    maxBytes: LEGACY_TOGGLE_STATE_MAX_BYTES,
    recoveryMaxBytes: LEGACY_TOGGLE_RECOVERY_MAX_BYTES,
    oversizedSource: ({ filePath, maxBytes }) => ({
      warning: `Skipped Active Memory session toggle migration because ${filePath} exceeds ${maxBytes} bytes; left legacy source in place`,
      preview: `- Active Memory session toggles: legacy source exceeds ${maxBytes} bytes and cannot be recovered; left in place`,
    }),
    capacityPrecheck: {
      warning: ({ available, missing }) =>
        `Skipped Active Memory session toggle migration because plugin state has room for ${available} of ${missing} missing entries; left legacy source in place`,
    },
    describeEntries: (entries) => ({
      preview: [
        `- Active Memory session toggles: ${entries.length} ${entries.length === 1 ? "entry" : "entries"} -> plugin state (${SESSION_TOGGLES_NAMESPACE})`,
      ],
      change: ({ imported }) =>
        imported > 0
          ? `Migrated ${imported} Active Memory session toggle ${imported === 1 ? "entry" : "entries"} -> plugin state`
          : null,
    }),
    toRows: (entries) =>
      entries.map((entry) => ({
        key: activeMemoryToggleKey(entry.sessionKey),
        value: entry,
      })),
  }),
];
