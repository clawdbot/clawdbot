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
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
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
  const selectedGlobalAgentId = isUiGlobalSessionKey(host.sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : undefined;
  const current = canonicalVisibleSessionIdentity(host, host.sessionKey, selectedGlobalAgentId);
  const candidate = canonicalVisibleSessionIdentity(host, sessionKey, agentId);
  return (
    current !== null &&
    candidate !== null &&
    current.conversationKey === candidate.conversationKey &&
    current.ownerAgentId === candidate.ownerAgentId
  );
}

type VisibleSessionIdentity = {
  conversationKey: string;
  ownerAgentId: string;
};

function canonicalVisibleSessionIdentity(
  host: SessionScopeHost,
  sessionKey: string,
  agentId: string | undefined,
): VisibleSessionIdentity | null {
  const normalizedKey = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalizedKey) {
    return null;
  }

  const parsed = parseAgentSessionKey(sessionKey);
  const qualifiedAliasAgentId = resolveUiGlobalAliasAgentId(host, sessionKey);
  const isRawGlobal = isUiGlobalSessionKey(sessionKey);
  const isBareMainAlias =
    !parsed && (normalizedKey === "main" || normalizedKey === resolveUiConfiguredMainKey(host));
  const isGlobalConversation = isRawGlobal || isBareMainAlias || qualifiedAliasAgentId !== null;
  const explicitOwner = normalizeOptionalString(agentId);
  const normalizedExplicitOwner = explicitOwner ? normalizeAgentId(explicitOwner) : undefined;
  const routeOwner = parsed
    ? normalizeAgentId(parsed.agentId)
    : isRawGlobal
      ? (normalizedExplicitOwner ?? resolveUiDefaultAgentId(host))
      : resolveUiDefaultAgentId(host);

  // Every route except raw global carries its owner in the key/default alias.
  // Reject contradictory metadata instead of letting it join another outbox.
  if (!isRawGlobal && normalizedExplicitOwner && normalizedExplicitOwner !== routeOwner) {
    return null;
  }

  return {
    conversationKey: isGlobalConversation
      ? "global"
      : normalizeSessionKeyForUiComparison(sessionKey),
    ownerAgentId: routeOwner,
  };
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

type VisibleSessionRowOptions = {
  currentSessionKey?: string;
  agentId: string;
  defaultAgentId: string;
  filterByAgent?: boolean;
  hideCron?: boolean;
};

export function filterVisibleSessionRows(
  rows: readonly GatewaySessionRow[],
  options: VisibleSessionRowOptions,
): GatewaySessionRow[] {
  return rows.filter((row) => {
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

export function getVisibleSessionRows(
  result: SessionsListResult | null,
  options: VisibleSessionRowOptions,
): GatewaySessionRow[] {
  return filterVisibleSessionRows(result?.sessions ?? [], options);
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
