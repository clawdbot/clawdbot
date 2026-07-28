import type { SessionsListResult } from "../../api/types.ts";
import { isCronSessionKey } from "../session-display.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import {
  buildAgentMainSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";

type SessionAgentOptionsState = {
  agentsList?: {
    defaultId?: string | null;
    agents?: Array<{
      id: string;
      name?: string | null;
      identity?: { name?: string | null } | null;
    }> | null;
  } | null;
  chatAgentSessionRowsByAgent?: Record<string, SessionsListResult["sessions"]>;
  sessionsResult?: SessionsListResult | null;
  sessionKey: string;
};

type SessionAgentFilterOption = {
  id: string;
  label: string;
};

export function resolveSessionAgentFilterId(
  state: SessionAgentOptionsState,
  sessionKey: string,
): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function resolvePreferredSessionCandidateAgentId(
  row: SessionsListResult["sessions"][number],
  defaultAgentId: string,
): string | null {
  if (row.kind === "global" || row.kind === "unknown" || isCronSessionKey(row.key)) {
    return null;
  }
  if (isSubagentSessionKey(row.key) || row.spawnedBy) {
    return null;
  }
  const parsed = parseAgentSessionKey(row.key);
  return normalizeAgentId(parsed?.agentId ?? defaultAgentId);
}

function rowsForPreferredAgentSession(
  state: SessionAgentOptionsState,
  normalizedAgentId: string,
  defaultAgentId: string,
): SessionsListResult["sessions"] {
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of state.chatAgentSessionRowsByAgent?.[normalizedAgentId] ?? []) {
    byKey.set(row.key, row);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    if (resolvePreferredSessionCandidateAgentId(row, defaultAgentId) === normalizedAgentId) {
      byKey.set(row.key, row);
    }
  }
  return [...byKey.values()];
}

export function resolvePreferredSessionForAgent(
  state: SessionAgentOptionsState,
  agentId: string,
): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (resolveSessionAgentFilterId(state, state.sessionKey) === normalizedAgentId) {
    return state.sessionKey;
  }
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const eligible = rowsForPreferredAgentSession(state, normalizedAgentId, defaultAgentId)
    .filter((row) => {
      if (!isSessionKeyTiedToAgent(row.key, normalizedAgentId, defaultAgentId)) {
        return false;
      }
      return resolvePreferredSessionCandidateAgentId(row, defaultAgentId) === normalizedAgentId;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (eligible[0]?.key) {
    return eligible[0].key;
  }
  return buildAgentMainSessionKey({ agentId: normalizedAgentId });
}

export function resolveSessionAgentFilterOptions(
  state: SessionAgentOptionsState,
): SessionAgentFilterOption[] {
  const seen = new Set<string>();
  const options: SessionAgentFilterOption[] = [];
  const add = (agentId: string) => {
    const normalized = normalizeAgentId(agentId);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    options.push({
      id: normalized,
      label: resolveAgentGroupLabel(state, normalized),
    });
  };

  add(resolveSessionAgentFilterId(state, state.sessionKey));
  add(state.agentsList?.defaultId ?? "main");
  for (const agent of state.agentsList?.agents ?? []) {
    add(agent.id);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    const parsed = parseAgentSessionKey(row.key);
    if (parsed) {
      add(parsed.agentId);
    }
  }

  return options;
}

function resolveAgentGroupLabel(state: SessionAgentOptionsState, agentIdRaw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(agentIdRaw);
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalized,
  );
  const name =
    normalizeOptionalString(agent?.identity?.name) ?? normalizeOptionalString(agent?.name) ?? "";
  return name && name !== agentIdRaw ? `${name} (${agentIdRaw})` : agentIdRaw;
}
