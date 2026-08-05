import { isEmbeddedAgentRunInProgress } from "../../agents/embedded-agent-runner/runs.js";
import {
  hasProjectedAgentRunForSession,
  type ProjectedAgentRunIndex,
} from "../../infra/agent-run-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

/** Active-run matcher for Control UI-visible controllers. */
type TrackedActiveSessionRun = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const [runId, active] of context.chatAbortControllers) {
    if (active.projectSessionActive === false || active.controlUiVisible === false) {
      continue;
    }
    const sessionKey = active.sessionKey?.trim();
    const sessionId = active.sessionId?.trim();
    if (!sessionKey && !sessionId) {
      continue;
    }
    runs.push({
      runId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(sessionId ? { sessionId } : {}),
      agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
    });
  }
  return runs;
}

type TrackedActiveSessionRunSnapshot = {
  hasActiveRun: boolean;
  runs: Array<{
    runId: string;
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    kind?: "chat-send" | "agent";
    startedAtMs?: number;
    expiresAtMs?: number;
    startedAgeMs?: number;
    expiresInMs?: number;
    terminalPending?: boolean;
    terminalPersisted?: boolean;
  }>;
};

export function collectTrackedActiveSessionRunSnapshot(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  scopeUnknownByAgent?: boolean;
  requireFallbackAgentOwnership?: boolean;
  now?: number;
}): TrackedActiveSessionRunSnapshot {
  const runs: TrackedActiveSessionRunSnapshot["runs"] = [];
  const targetSessionId = params.sessionId?.trim() || undefined;
  const hasProjectedRun = hasProjectedAgentRunForSession({
    sessionKeys: [params.requestedKey, params.canonicalKey],
    ...(targetSessionId ? { sessionId: targetSessionId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    ...(params.scopeUnknownByAgent !== undefined
      ? { scopeUnknownByAgent: params.scopeUnknownByAgent }
      : {}),
    ...(params.requireFallbackAgentOwnership !== undefined
      ? { requireFallbackAgentOwnership: params.requireFallbackAgentOwnership }
      : {}),
  });
  if (!(params.context.chatAbortControllers instanceof Map)) {
    return { hasActiveRun: hasProjectedRun, runs };
  }
  const now = params.now ?? Date.now();
  for (const [runId, active] of params.context.chatAbortControllers.entries()) {
    const sessionKey = active.sessionKey?.trim();
    const sessionId = active.sessionId?.trim();
    if (
      active.projectSessionActive === false ||
      active.controlUiVisible === false ||
      (!sessionKey && !sessionId)
    ) {
      continue;
    }
    const projected: TrackedActiveSessionRun = {
      runId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(sessionId ? { sessionId } : {}),
      agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
    };
    const matches = isTrackedActiveSessionRunForTarget(projected, {
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
      ...(targetSessionId ? { sessionId: targetSessionId } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
      ...(params.scopeUnknownByAgent !== undefined
        ? { scopeUnknownByAgent: params.scopeUnknownByAgent }
        : {}),
      ...(params.requireFallbackAgentOwnership !== undefined
        ? { requireFallbackAgentOwnership: params.requireFallbackAgentOwnership }
        : {}),
    });
    if (!matches) {
      continue;
    }
    const visibleSessionId = sessionId ?? targetSessionId;
    if (!visibleSessionId) {
      continue;
    }
    runs.push({
      runId,
      sessionId: visibleSessionId,
      sessionKey: sessionKey ?? params.canonicalKey,
      ...(projected.agentId ? { agentId: projected.agentId } : {}),
      ...(active.kind ? { kind: active.kind } : {}),
      ...(typeof active.startedAtMs === "number"
        ? {
            startedAtMs: active.startedAtMs,
            startedAgeMs: Math.max(0, now - active.startedAtMs),
          }
        : {}),
      ...(typeof active.expiresAtMs === "number"
        ? {
            expiresAtMs: active.expiresAtMs,
            expiresInMs: Math.max(0, active.expiresAtMs - now),
          }
        : {}),
      ...(active.projectSessionTerminalPending !== undefined
        ? { terminalPending: active.projectSessionTerminalPending }
        : {}),
      ...(active.projectSessionTerminalPersisted !== undefined
        ? { terminalPersisted: active.projectSessionTerminalPersisted }
        : {}),
    });
  }
  return {
    hasActiveRun: runs.length > 0 || hasProjectedRun,
    runs: runs.toSorted((a, b) => a.runId.localeCompare(b.runId)),
  };
}

function isTrackedActiveSessionRunForKey(
  active: TrackedActiveSessionRun,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
  options?: {
    scopeUnknownByAgent?: boolean;
    requireFallbackAgentOwnership?: boolean;
  },
): boolean {
  if (!active.sessionKey || active.sessionKey !== key) {
    return false;
  }
  const shouldScopeByAgent =
    key === "global" || (key === "unknown" && options?.scopeUnknownByAgent === true);
  if (!shouldScopeByAgent) {
    return true;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return true;
  }
  if (!active.agentId && options?.requireFallbackAgentOwnership === true) {
    return false;
  }
  const activeAgentId = active.agentId ?? defaultAgentId;
  return activeAgentId
    ? normalizeAgentId(activeAgentId) === normalizeAgentId(requestedAgentId)
    : false;
}

function isTrackedActiveSessionRunForTarget(
  active: TrackedActiveSessionRun,
  params: {
    requestedKey: string;
    canonicalKey: string;
    sessionId?: string;
    agentId?: string;
    defaultAgentId?: string;
    scopeUnknownByAgent?: boolean;
    requireFallbackAgentOwnership?: boolean;
  },
): boolean {
  const matchesCanonicalKey = isTrackedActiveSessionRunForKey(
    active,
    params.canonicalKey,
    params.agentId,
    params.defaultAgentId,
    {
      scopeUnknownByAgent: params.scopeUnknownByAgent,
      requireFallbackAgentOwnership: params.requireFallbackAgentOwnership,
    },
  );
  const matchesRequestedKey =
    params.requestedKey === params.canonicalKey
      ? matchesCanonicalKey
      : isTrackedActiveSessionRunForKey(
          active,
          params.requestedKey,
          params.agentId,
          params.defaultAgentId,
          {
            scopeUnknownByAgent: params.scopeUnknownByAgent,
            requireFallbackAgentOwnership: params.requireFallbackAgentOwnership,
          },
        );
  const targetSessionId = params.sessionId?.trim() || undefined;
  const targetAgentId = resolveActiveRunTargetAgentId(params);
  const fallbackTarget =
    params.canonicalKey === "global" ||
    params.requestedKey === "global" ||
    (params.scopeUnknownByAgent === true &&
      (params.canonicalKey === "unknown" || params.requestedKey === "unknown"));
  const requiresFallbackAgentOwnership =
    fallbackTarget && params.requireFallbackAgentOwnership === true;
  const activeAgentId = active.agentId ? normalizeAgentId(active.agentId) : undefined;
  const activeAgentMatchesTarget =
    targetAgentId === undefined ||
    activeAgentId === targetAgentId ||
    (activeAgentId === undefined && !requiresFallbackAgentOwnership);
  // Session-id-only controllers predate keyed run state; keyed controllers must
  // still match the diagnosed key so a reused id cannot borrow another session's run.
  const matchesSessionId =
    targetSessionId !== undefined &&
    active.sessionId === targetSessionId &&
    activeAgentMatchesTarget &&
    (!active.sessionKey || matchesCanonicalKey || matchesRequestedKey);
  return matchesCanonicalKey || matchesRequestedKey || matchesSessionId;
}

function resolveActiveRunTargetAgentId(params: {
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): string | undefined {
  if (params.agentId) {
    return normalizeAgentId(params.agentId);
  }
  const canonicalAgentId = parseAgentSessionKey(params.canonicalKey)?.agentId;
  if (canonicalAgentId) {
    return normalizeAgentId(canonicalAgentId);
  }
  const requestedAgentId = parseAgentSessionKey(params.requestedKey)?.agentId;
  if (requestedAgentId) {
    return normalizeAgentId(requestedAgentId);
  }
  return params.defaultAgentId ? normalizeAgentId(params.defaultAgentId) : undefined;
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
  excludeRunIds?: ReadonlySet<string>;
  scopeUnknownByAgent?: boolean;
  requireFallbackAgentOwnership?: boolean;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context);
  return activeRuns.some(
    (active) =>
      !params.excludeRunIds?.has(active.runId) &&
      (isTrackedActiveSessionRunForKey(
        active,
        params.canonicalKey,
        params.agentId,
        params.defaultAgentId,
        {
          scopeUnknownByAgent: params.scopeUnknownByAgent,
          requireFallbackAgentOwnership: params.requireFallbackAgentOwnership,
        },
      ) ||
        isTrackedActiveSessionRunForKey(
          active,
          params.requestedKey,
          params.agentId,
          params.defaultAgentId,
          {
            scopeUnknownByAgent: params.scopeUnknownByAgent,
            requireFallbackAgentOwnership: params.requireFallbackAgentOwnership,
          },
        )),
  );
}

export function resolveVisibleActiveSessionRunState(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  trackedActiveRuns?: readonly TrackedActiveSessionRun[];
  projectedAgentRunIndex?: ProjectedAgentRunIndex;
  scopeUnknownByAgent?: boolean;
  requireFallbackAgentOwnership?: boolean;
}): { active: boolean; runIds: string[] } {
  const sessionId = params.sessionId?.trim();
  const runIds = (params.trackedActiveRuns ?? collectTrackedActiveSessionRuns(params.context))
    .filter((active) =>
      isTrackedActiveSessionRunForTarget(active, {
        requestedKey: params.requestedKey,
        canonicalKey: params.canonicalKey,
        ...(sessionId ? { sessionId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
        ...(params.scopeUnknownByAgent !== undefined
          ? { scopeUnknownByAgent: params.scopeUnknownByAgent }
          : {}),
        ...(params.requireFallbackAgentOwnership !== undefined
          ? { requireFallbackAgentOwnership: params.requireFallbackAgentOwnership }
          : {}),
      }),
    )
    .map((active) => active.runId)
    .toSorted();
  const hasProjectedRun = hasProjectedAgentRunForSession({
    sessionKeys: [params.requestedKey, params.canonicalKey],
    ...(sessionId ? { sessionId } : {}),
    ...(params.projectedAgentRunIndex ? { index: params.projectedAgentRunIndex } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    ...(params.scopeUnknownByAgent !== undefined
      ? { scopeUnknownByAgent: params.scopeUnknownByAgent }
      : {}),
    ...(params.requireFallbackAgentOwnership !== undefined
      ? { requireFallbackAgentOwnership: params.requireFallbackAgentOwnership }
      : {}),
  });
  const embeddedRunInProgress = sessionId !== undefined && isEmbeddedAgentRunInProgress(sessionId);
  // Connection, worker-lifecycle, and embedded registries are independent owners.
  // Settlement in one must not hide live work owned by another.
  return {
    active: runIds.length > 0 || hasProjectedRun || embeddedRunInProgress,
    runIds,
  };
}

export function hasVisibleActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  scopeUnknownByAgent?: boolean;
  requireFallbackAgentOwnership?: boolean;
}): boolean {
  return resolveVisibleActiveSessionRunState(params).active;
}
