import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { isCronSessionKey } from "../session-display.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../string-coerce.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";
export type SessionNavigationInput = {
  result: SessionsListResult | null;
  resultAgentId?: string | null;
  sessionKey: string;
  assistantAgentId?: string | null;
  hello?: GatewayHelloOk | null;
  compareSessions?: (a: GatewaySessionRow, b: GatewaySessionRow) => number;
};

export type SessionNavigation = {
  currentSessionKey: string;
  selectedAgentId: string;
  defaultAgentId: string;
  selectedSession?: GatewaySessionRow;
  visibleSessions: GatewaySessionRow[];
  activeRowKey: string | null;
};

export type SessionScopeHost = {
  assistantAgentId?: string | null;
  agentsList?: {
    defaultId?: string | null;
    mainKey?: string | null;
    scope?: string | null;
    agents?: Array<{ id: string }>;
  } | null;
  hello: GatewayHelloOk | null;
};

export type SessionScopeHostWithKey = SessionScopeHost & {
  sessionKey: string;
};

export type SessionRefreshTarget = { sessionKey: string; agentId?: string };

type SessionDefaults = {
  defaultAgentId?: string | null;
  mainKey?: string | null;
  mainSessionKey?: string | null;
};

function readSessionDefaults(
  host: Pick<SessionNavigationInput, "hello">,
): SessionDefaults | undefined {
  const snapshot = host.hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return undefined;
  }
  const defaults = snapshot.sessionDefaults;
  return defaults && typeof defaults === "object" ? (defaults as SessionDefaults) : undefined;
}

export function resolveSessionKey(
  sessionKey: string | undefined | null,
  hello: GatewayHelloOk | null | undefined,
): string {
  const raw = normalizeOptionalString(sessionKey) ?? "";
  const defaults = readSessionDefaults({ hello });
  const mainSessionKey = normalizeOptionalString(defaults?.mainSessionKey);
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = normalizeOptionalLowercaseString(defaults?.mainKey) ?? "main";
  const defaultAgentId = normalizeOptionalString(defaults?.defaultAgentId);
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function readHelloDefaultAgentId(host: Pick<SessionScopeHost, "hello">): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return snapshot?.sessionDefaults?.defaultAgentId?.trim() || undefined;
}

export function scopedAgentIdForSession(
  host: SessionScopeHost,
  sessionKey: string | undefined | null,
): string | undefined {
  return isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : (resolveUiGlobalAliasAgentId(host, sessionKey) ?? undefined);
}

export function scopedAgentParamsForSession(
  host: SessionScopeHost,
  sessionKey: string,
): { agentId?: string } {
  const agentId = isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : resolveUiGlobalAliasAgentId(host, sessionKey);
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}

export function scopedAgentListParamsForSession(
  host: SessionScopeHost,
  sessionKey: string,
): { agentId?: string } {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const agentId =
    parsed?.agentId ??
    (normalizedSessionKey === "global"
      ? resolveUiKnownSelectedGlobalAgentId(host)
      : normalizedSessionKey === "unknown"
        ? undefined
        : resolveUiDefaultAgentId(host));
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}

export function scopedAgentListParamsForRefreshTarget(
  host: SessionScopeHost,
  target: SessionRefreshTarget,
): { agentId?: string } {
  const agentId =
    normalizeOptionalString(target.agentId) ??
    scopedAgentListParamsForSession(host, target.sessionKey).agentId;
  return agentId ? { agentId } : {};
}

export function visibleSessionMatches(
  host: SessionScopeHostWithKey,
  sessionKey: string,
  agentId: string | undefined,
): boolean {
  if (host.sessionKey !== sessionKey) {
    const hostAliasAgentId = resolveUiGlobalAliasAgentId(host, host.sessionKey);
    if (!hostAliasAgentId || !isUiGlobalSessionKey(sessionKey)) {
      return false;
    }
    const expectedAgentId = agentId ?? host.agentsList?.defaultId ?? readHelloDefaultAgentId(host);
    return expectedAgentId
      ? normalizeAgentId(hostAliasAgentId) === normalizeAgentId(expectedAgentId)
      : normalizeAgentId(hostAliasAgentId) === resolveUiDefaultAgentId(host);
  }
  if (!isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  const selectedAgentId = resolveUiKnownSelectedGlobalAgentId(host);
  const expectedAgentId = agentId
    ? normalizeAgentId(agentId)
    : host.agentsList?.defaultId
      ? normalizeAgentId(host.agentsList.defaultId)
      : readHelloDefaultAgentId(host);
  return expectedAgentId
    ? normalizeAgentId(selectedAgentId ?? "") === normalizeAgentId(expectedAgentId)
    : selectedAgentId === undefined;
}

export function filterSessionRows(
  result: SessionsListResult,
  options: { showArchived: boolean },
): SessionsListResult {
  const sessions = result.sessions.filter(
    (row) => row.key && (row.archived === true) === options.showArchived,
  );
  return {
    ...result,
    count: sessions.length,
    sessions,
  };
}

export function getVisibleSessionRows(
  result: SessionsListResult | null,
  options: {
    currentSessionKey?: string;
    agentId: string;
    defaultAgentId: string;
    filterByAgent?: boolean;
    hideCron?: boolean;
  },
): GatewaySessionRow[] {
  return (result?.sessions ?? []).filter((row) => {
    if (row.key === options.currentSessionKey) {
      return true;
    }
    return (
      !row.archived &&
      row.kind !== "global" &&
      row.kind !== "unknown" &&
      (options.hideCron === false || (row.kind !== "cron" && !isCronSessionKey(row.key))) &&
      !isSubagentSessionKey(row.key) &&
      !row.spawnedBy &&
      (!options.filterByAgent ||
        isSessionKeyTiedToAgent(row.key, options.agentId, options.defaultAgentId))
    );
  });
}

export function compareSessionRowsByUpdatedAt(a: GatewaySessionRow, b: GatewaySessionRow): number {
  const pinnedStateDiff = Number(b.pinned === true) - Number(a.pinned === true);
  if (pinnedStateDiff !== 0) {
    return pinnedStateDiff;
  }
  const pinnedDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  return pinnedDiff !== 0 ? pinnedDiff : (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

export function resolveSessionNavigation(input: SessionNavigationInput): SessionNavigation {
  const currentSessionKey = resolveSessionKey(input.sessionKey, input.hello);
  const defaultAgentId = resolveUiSelectedGlobalAgentId({
    assistantAgentId: input.assistantAgentId,
    hello: input.hello,
  });
  const selectedAgentId = parseAgentSessionKey(currentSessionKey)?.agentId ?? defaultAgentId;
  const shouldFilterByAgent = currentSessionKey.toLowerCase() !== "unknown";
  const resultScopeMatches =
    normalizeOptionalString(input.resultAgentId) !== undefined &&
    normalizeAgentId(input.resultAgentId) === normalizeAgentId(selectedAgentId);
  const matchesCurrentSession = (row: GatewaySessionRow) =>
    areUiSessionKeysEquivalent(row.key, currentSessionKey) ||
    (resultScopeMatches && uiSessionRowMatchesSelectedChat(input, row.key, currentSessionKey));
  const selectedSession = input.result?.sessions.find(matchesCurrentSession);
  const activeSession =
    currentSessionKey && currentSessionKey.toLowerCase() !== "unknown"
      ? { ...(selectedSession ?? { kind: "direct", updatedAt: null }), key: currentSessionKey }
      : undefined;
  const sortedSessions = getVisibleSessionRows(input.result, {
    currentSessionKey: currentSessionKey || undefined,
    agentId: selectedAgentId,
    defaultAgentId,
    filterByAgent: shouldFilterByAgent,
  }).toSorted(input.compareSessions ?? compareSessionRowsByUpdatedAt);
  // The sidebar is the session list, not a recent-session preview. Keep every
  // active row in its sorted slot so selecting a session never reshuffles or
  // hides another one behind a separate route.
  let visibleSessions = sortedSessions;
  let activeRow = visibleSessions.find(matchesCurrentSession);
  if (!activeRow && activeSession) {
    // Deep-linked and archived sessions still need a visible selected row.
    activeRow = sortedSessions.find(matchesCurrentSession) ?? activeSession;
    visibleSessions = [activeRow, ...visibleSessions.filter((row) => row !== activeRow)];
  }
  return {
    currentSessionKey,
    selectedAgentId,
    defaultAgentId,
    selectedSession: activeSession,
    visibleSessions,
    activeRowKey: activeRow?.key ?? null,
  };
}

export function searchForSession(sessionKey: string): string {
  return `?session=${encodeURIComponent(sessionKey)}`;
}
