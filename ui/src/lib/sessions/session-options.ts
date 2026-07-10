import type { SessionsListResult } from "../../api/types.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import { normalizeAgentId, parseAgentSessionKey } from "./session-key.ts";

type SessionAgentOptionsState = {
  agentsList?: {
    defaultId?: string | null;
    agents?: Array<{
      id: string;
      name?: string | null;
      identity?: { name?: string | null } | null;
    }> | null;
  } | null;
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
