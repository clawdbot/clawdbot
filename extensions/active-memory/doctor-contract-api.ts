/**
 * Doctor migration contract for Active Memory state. It moves legacy per-session
 * toggle JSON into the plugin state keyed store used by current runtimes.
 */
import crypto from "node:crypto";
import path from "node:path";
import {
  defineLegacyJsonStateMigration,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";

type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: boolean;
  updatedAt: number;
};

const TOGGLE_STATE_FILE = "session-toggles.json";
const SESSION_TOGGLES_NAMESPACE = "session-toggles";
const MAX_TOGGLE_ENTRIES = 10_000;

function resolveToggleStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "active-memory", TOGGLE_STATE_FILE);
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function normalizeLegacyUpdatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function parseLegacyToggleEntries(parsed: unknown): ActiveMemoryToggleEntry[] | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    return null;
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
