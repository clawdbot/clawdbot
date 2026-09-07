/**
 * Exact owned runTarget for realtime voice control when the caller has an
 * agent id + session key but no browser/client connection id.
 *
 * Talk gateway ownership stays on resolveOwnedActiveTalkRunTarget (clientConnId).
 * Callers that omit runTarget fall into session-key legacy control; pass null
 * instead when ownership cannot be proven (fail-closed).
 */
import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
} from "../agents/embedded-agent-runner/run-state.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../agents/embedded-agent-runner/runs.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

export type RealtimeVoiceAgentRunTarget = {
  runId: string;
  signal: AbortSignal;
  isCurrent: (sessionId?: string) => boolean;
};

function resolveRecordedAgentId(recorded: {
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const raw = recorded.agentId ?? parseAgentSessionKey(recorded.sessionKey)?.agentId;
  return raw ? normalizeAgentId(raw) : undefined;
}

/** Admit an exact embedded run for sessionKey+agentId, or null when unproven. */
export function resolveOwnedActiveRealtimeVoiceRunTargetForAgent(params: {
  sessionKey: string;
  agentId: string;
  isSessionCurrent?: () => boolean;
}): RealtimeVoiceAgentRunTarget | null {
  const sessionKey = params.sessionKey.trim();
  const agentId = normalizeAgentId(params.agentId);
  if (!sessionKey || !agentId) {
    return null;
  }
  if (params.isSessionCurrent && !params.isSessionCurrent()) {
    return null;
  }

  const sessionId = resolveActiveEmbeddedRunSessionId(sessionKey);
  if (!sessionId) {
    return null;
  }

  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
  const runId = handle?.runId?.trim();
  if (!handle || !registration || !runId) {
    return null;
  }
  if (registration.sessionKey !== undefined && registration.sessionKey !== sessionKey) {
    return null;
  }
  // Prefer the registration's recorded agentId so a colliding foreign owner on
  // the same sessionKey cannot be admitted from the key's embedded agent segment.
  if (resolveRecordedAgentId(registration) !== agentId) {
    return null;
  }
  if (!resolveActiveEmbeddedRunOwnerByRunId(runId)) {
    return null;
  }

  // Voice session lifecycle is the liveness fence; isCurrent rechecks the exact
  // admitted handle so a replacement run cannot inherit this claim.
  const signal = new AbortController().signal;
  const isCurrent = (resolvedSessionId?: string) => {
    if (params.isSessionCurrent && !params.isSessionCurrent()) {
      return false;
    }
    if (signal.aborted) {
      return false;
    }
    const liveHandle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const liveRegistration = liveHandle
      ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(liveHandle)
      : undefined;
    if (
      liveHandle !== handle ||
      liveRegistration !== registration ||
      liveHandle.runId !== runId ||
      resolveRecordedAgentId(liveRegistration ?? {}) !== agentId ||
      (liveRegistration?.sessionKey !== undefined && liveRegistration.sessionKey !== sessionKey)
    ) {
      return false;
    }
    if (resolvedSessionId !== undefined && resolvedSessionId !== sessionId) {
      return false;
    }
    return Boolean(resolveActiveEmbeddedRunOwnerByRunId(runId));
  };

  if (!isCurrent()) {
    return null;
  }
  return { runId, signal, isCurrent };
}
