import { resolveEmbeddedAgentRunProgressState } from "../../agents/embedded-agent-runner/runs.js";
import {
  hasProjectedAgentRunForSession,
  type ProjectedAgentRunIndex,
} from "../../infra/agent-run-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import type { GatewayRequestContext } from "./types.js";

/** Active-run matcher including hidden remote lifecycle projections. */
type TrackedActiveSessionRun = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  executionStarted: boolean;
  terminalPersistence?: boolean;
};

type VisibleActiveSessionRunState = {
  active: boolean;
  /** Complete exact active set. Omitted when another active owner exposes only liveness. */
  runIds?: string[];
  status?: "queued";
};

export function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
  includeTerminalPersistence = false,
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const [runId, active] of context.chatAbortControllers) {
    const terminalPersistence =
      includeTerminalPersistence &&
      active.projectSessionActive === false &&
      active.projectSessionTerminalPending === true;
    if (
      (active.projectSessionActive !== false || terminalPersistence) &&
      active.controlUiVisible !== false
    ) {
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
        // Entries created before this state existed are already executing.
        executionStarted: active.executionStarted !== false,
        ...(terminalPersistence ? { terminalPersistence: true } : {}),
      });
    }
  }
  return runs;
}

function isTrackedActiveSessionRunForKey(
  active: Pick<TrackedActiveSessionRun, "sessionKey" | "agentId">,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (!active.sessionKey || active.sessionKey !== key) {
    return false;
  }
  const requestedAgentId = resolveChatRunOwnerAgentId({
    agentId,
    sessionKey: key,
    defaultAgentId,
  });
  if (!requestedAgentId) {
    return false;
  }
  const activeAgentId = resolveChatRunOwnerAgentId({
    agentId: active.agentId,
    sessionKey: active.sessionKey,
    defaultAgentId,
  });
  return activeAgentId
    ? normalizeAgentId(activeAgentId) === normalizeAgentId(requestedAgentId)
    : false;
}

function isTrackedActiveSessionRunForSessionId(
  active: TrackedActiveSessionRun,
  sessionId: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (active.sessionId !== sessionId) {
    return false;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return false;
  }
  return (
    resolveChatRunOwnerAgentId({
      agentId: active.agentId,
      sessionKey: active.sessionKey,
      defaultAgentId,
    }) === normalizeAgentId(requestedAgentId)
  );
}

export function hasRegisteredChatRunForSessionKey(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  sessionKey: string;
  agentId: string | undefined;
  defaultAgentId?: string;
}): boolean {
  const controllers = params.context.chatAbortControllers;
  return (
    controllers instanceof Map &&
    [...controllers.values()].some((active) =>
      isTrackedActiveSessionRunForKey(
        active,
        params.sessionKey,
        params.agentId,
        params.defaultAgentId,
      ),
    )
  );
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
  excludeRunIds?: ReadonlySet<string>;
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
      ) ||
        isTrackedActiveSessionRunForKey(
          active,
          params.requestedKey,
          params.agentId,
          params.defaultAgentId,
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
  includeTerminalPersistence?: boolean;
}): VisibleActiveSessionRunState {
  const sessionId = params.sessionId?.trim();
  const resolvedAgentId =
    params.agentId ??
    parseAgentSessionKey(params.canonicalKey)?.agentId ??
    parseAgentSessionKey(params.requestedKey)?.agentId;
  const matchesRequestedSession = (active: TrackedActiveSessionRun) =>
    isTrackedActiveSessionRunForKey(
      active,
      params.canonicalKey,
      resolvedAgentId,
      params.defaultAgentId,
    ) ||
    isTrackedActiveSessionRunForKey(
      active,
      params.requestedKey,
      resolvedAgentId,
      params.defaultAgentId,
    ) ||
    (sessionId !== undefined &&
      isTrackedActiveSessionRunForSessionId(
        active,
        sessionId,
        resolvedAgentId,
        params.defaultAgentId,
      ));
  const matchingTrackedRuns = (
    params.trackedActiveRuns ??
    collectTrackedActiveSessionRuns(params.context, params.includeTerminalPersistence)
  ).filter(matchesRequestedSession);
  const hasTerminalPersistence = matchingTrackedRuns.some((active) => active.terminalPersistence);
  const runIds = matchingTrackedRuns
    .filter((active) => !active.terminalPersistence)
    .map((active) => active.runId)
    .toSorted();
  const hasProjectedRun = hasProjectedAgentRunForSession({
    sessionKeys: [params.requestedKey, params.canonicalKey],
    ...(sessionId ? { sessionId } : {}),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    ...(params.projectedAgentRunIndex ? { index: params.projectedAgentRunIndex } : {}),
  });
  const embeddedRunState =
    sessionId === undefined ? undefined : resolveEmbeddedAgentRunProgressState(sessionId);
  // Connection, worker-lifecycle, and embedded registries are independent owners.
  // Settlement in one must not hide live work owned by another.
  const running =
    matchingTrackedRuns.some((active) => active.executionStarted) ||
    hasProjectedRun ||
    embeddedRunState === "running";
  const active = running || matchingTrackedRuns.length > 0 || embeddedRunState === "queued";
  // Terminal persistence is history visibility, not operational run identity.
  // Omit the exact set until the persisted terminal projection releases it.
  const identitiesComplete =
    !hasProjectedRun && embeddedRunState === undefined && !hasTerminalPersistence;
  return {
    active,
    ...(identitiesComplete ? { runIds } : {}),
    ...(active && !running ? { status: "queued" as const } : {}),
  };
}
