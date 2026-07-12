import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent-runner/runs.js";
import { hasProjectedAgentRunForSession } from "../../infra/agent-events.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

/** Active-run matcher including hidden remote lifecycle projections. */
type TrackedActiveSessionRun = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const [runId, active] of context.chatAbortControllers) {
    if (active.projectSessionActive !== false && active.controlUiVisible !== false) {
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
  }
  return runs;
}

function isTrackedActiveSessionRunForKey(
  active: TrackedActiveSessionRun,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (!active.sessionKey || active.sessionKey !== key) {
    return false;
  }
  if (key !== "global") {
    return true;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return true;
  }
  const activeAgentId = active.agentId ?? defaultAgentId;
  return activeAgentId
    ? normalizeAgentId(activeAgentId) === normalizeAgentId(requestedAgentId)
    : false;
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context);
  return activeRuns.some(
    (active) =>
      isTrackedActiveSessionRunForKey(
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
      ),
  );
}

export function resolveVisibleActiveSessionRunState(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
}): { active: boolean; runIds: string[] } {
  const sessionId = params.sessionId?.trim();
  const runIds = collectTrackedActiveSessionRuns(params.context)
    .filter(
      (active) =>
        isTrackedActiveSessionRunForKey(
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
        ) ||
        (sessionId !== undefined && active.sessionId === sessionId),
    )
    .map((active) => active.runId)
    .toSorted();
  const hasProjectedRun = hasProjectedAgentRunForSession({
    sessionKeys: [params.requestedKey, params.canonicalKey],
    ...(sessionId ? { sessionId } : {}),
  });
  return {
    active:
      runIds.length > 0 ||
      hasProjectedRun ||
      (sessionId !== undefined && isEmbeddedAgentRunActive(sessionId)),
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
}): boolean {
  return resolveVisibleActiveSessionRunState(params).active;
}
