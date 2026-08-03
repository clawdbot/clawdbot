import { normalizeGatewayTokenScope } from "../../app/gateway-scope.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const STORAGE_KEY_PREFIX = "openclaw.new-session.preferences.v1:";

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
  return `${STORAGE_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

function normalizePreference(value: unknown): NewSessionPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
