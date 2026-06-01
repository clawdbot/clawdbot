import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

type TrackedActiveSessionRun = {
  sessionKey: string;
  agentId?: string;
};

function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const active of context.chatAbortControllers.values()) {
    if (
      active.projectSessionActive !== false &&
      active.controlUiVisible !== false &&
      typeof active.sessionKey === "string" &&
      active.sessionKey.trim()
    ) {
      runs.push({
        sessionKey: active.sessionKey,
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
  if (active.sessionKey !== key) {
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
