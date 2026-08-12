import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const STORAGE_KEY_PREFIX = "openclaw.new-session.preferences.v1:";
const IDENTITY_KEY_PREFIX = "new-session.v1:";
export const PREFS_MIGRATION_KEY = "new-session.migration.v1";

export type NewSessionPreference = {
  workspace?: string;
  folder?: string;
  worktree?: boolean;
  model?: string;
  thinkingLevel?: string;
};

type PersistedPreferences = {
  agents?: Record<string, NewSessionPreference>;
};

function storageKey(gatewayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

function normalizePreference(value: unknown): NewSessionPreference | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const workspace = normalizeOptionalString(record.workspace);
  const folder = normalizeOptionalString(record.folder);
  const model = normalizeOptionalString(record.model);
  const thinkingLevel = normalizeOptionalString(record.thinkingLevel);
  const worktree = typeof record.worktree === "boolean" ? record.worktree : undefined;
  if (!workspace && !folder && worktree === undefined && !model && !thinkingLevel) {
    return null;
  }
  return {
    ...(workspace ? { workspace } : {}),
    ...(folder ? { folder } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function readStore(storage: Storage, gatewayUrl: string): PersistedPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(gatewayUrl)) ?? "null") as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed as PersistedPreferences;
  } catch {
    return {};
  }
}

export function loadNewSessionPreference(
  gatewayUrl: string,
  agentId: string,
): NewSessionPreference | null {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!storage || !gatewayUrl || !normalizedAgentId) {
    return null;
  }
  return normalizePreference(readStore(storage, gatewayUrl).agents?.[normalizedAgentId]);
}

export function loadBrowserPreferences(gatewayUrl: string): Record<string, NewSessionPreference> {
  const storage = getSafeLocalStorage();
  if (!storage || !gatewayUrl) {
    return {};
  }
  const entries = Object.entries(readStore(storage, gatewayUrl).agents ?? {}).flatMap(
    ([agentId, value]) => {
      const normalizedAgentId = normalizeAgentId(agentId);
      const preference = normalizePreference(value);
      return normalizedAgentId && preference ? [[normalizedAgentId, preference] as const] : [];
    },
  );
  return Object.fromEntries(entries);
}

export function encodeIdentityPreferences(
  preferences: Record<string, NewSessionPreference>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(preferences)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([agentId, preference]) => [`${IDENTITY_KEY_PREFIX}${agentId}`, preference]),
  );
}

export function decodeIdentityPreferences(
  entries: Record<string, unknown>,
): Record<string, NewSessionPreference> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) => {
      if (!key.startsWith(IDENTITY_KEY_PREFIX)) {
        return [];
      }
      const agentId = normalizeAgentId(key.slice(IDENTITY_KEY_PREFIX.length));
      const preference = normalizePreference(value);
      return agentId && preference ? [[agentId, preference] as const] : [];
    }),
  );
}

export function replaceBrowserPreference(
  gatewayUrl: string,
  agentId: string,
  preference: NewSessionPreference,
): void {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalized = normalizePreference(preference);
  if (!storage || !gatewayUrl || !normalizedAgentId || !normalized) {
    return;
  }
  const store = readStore(storage, gatewayUrl);
  try {
    storage.setItem(
      storageKey(gatewayUrl),
      JSON.stringify({
        ...store,
        agents: { ...store.agents, [normalizedAgentId]: normalized },
      } satisfies PersistedPreferences),
    );
  } catch {
    // Browser storage can be disabled or full; preferences are best effort.
  }
}

export function patchNewSessionPreference(
  gatewayUrl: string,
  agentId: string,
  patch: NewSessionPreference,
): void {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!storage || !gatewayUrl || !normalizedAgentId) {
    return;
  }
  const store = readStore(storage, gatewayUrl);
  const current = normalizePreference(store.agents?.[normalizedAgentId]) ?? {};
  const next = normalizePreference({ ...current, ...patch });
  if (!next) {
    return;
  }
  try {
    storage.setItem(
      storageKey(gatewayUrl),
      JSON.stringify({
        ...store,
        agents: { ...store.agents, [normalizedAgentId]: next },
      } satisfies PersistedPreferences),
    );
  } catch {
    // Browser storage can be disabled or full; preferences are best effort.
  }
}
