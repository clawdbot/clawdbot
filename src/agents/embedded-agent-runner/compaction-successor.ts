import path from "node:path";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult } from "../../context-engine/types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";

/** Resolve a context engine's successor without letting it cross the active store binding. */
export async function resolveContextEngineCompactionSuccessor(params: {
  config?: OpenClawConfig;
  currentSessionFile: string;
  currentTarget: SessionTranscriptRuntimeTarget;
  result: CompactResult;
}) {
  const current = params.currentTarget;
  const result = params.result.result;
  const target = result?.sessionTarget;
  const successorId = target?.sessionId ?? result?.sessionId;
  const successorFile = result?.sessionFile;
  // Shipped pre-sessionTarget engines report rotation via the deprecated
  // sessionFile field; honor it when no typed target is present.
  if (target) {
    if (result?.sessionId && target.sessionId && target.sessionId !== result.sessionId) {
      throw new Error("Context-engine successor identity is inconsistent");
    }
    const resolvedTarget = await resolveAgentRunSessionTarget({
      agentId: target.agentId ?? current.agentId,
      config: params.config,
      missingSessionKey: "resolve-existing",
      sessionId: target.sessionId ?? successorId ?? current.sessionId,
      sessionFile: successorFile,
      sessionKey: target.sessionKey ?? current.sessionKey,
      sessionTarget: {
        ...target,
        storePath: target.storePath ?? current.storePath,
      },
    });
    assertSameSessionBinding(current, resolvedTarget, "Context-engine");
    return {
      sessionId: resolvedTarget.sessionId,
      sessionFile: resolvedTarget.sessionKey,
      sessionTarget: resolvedTarget,
    };
  }

  if (successorFile) {
    const marker = parseSqliteSessionFileMarker(successorFile);
    if (
      marker &&
      (marker.agentId !== current.agentId || (successorId && marker.sessionId !== successorId))
    ) {
      throw new Error("Legacy context-engine successor identity is inconsistent");
    }
    const isSessionKey = successorFile.startsWith("agent:");
    const keyedEntry = isSessionKey
      ? loadSessionEntry({
          agentId: current.agentId,
          sessionKey: successorFile,
          storePath: current.storePath,
        })
      : undefined;
    if (
      isSessionKey &&
      (resolveAgentIdFromSessionKey(successorFile) !== current.agentId ||
        !keyedEntry?.sessionId ||
        (successorId && keyedEntry.sessionId !== successorId))
    ) {
      throw new Error("Legacy context-engine successor identity is inconsistent");
    }
    const keyedSessionId = isSessionKey ? (successorId ?? keyedEntry?.sessionId) : undefined;
    const retainedMarkerEntry = marker
      ? loadSessionEntry({
          agentId: marker.agentId,
          sessionKey: current.sessionKey,
          storePath: marker.storePath,
        })
      : undefined;
    const markerMatches = marker
      ? listSessionEntriesCore({
          agentId: marker.agentId,
          storePath: marker.storePath,
        }).filter(({ entry }) => entry.sessionId === marker.sessionId)
      : [];
    const preferredMarkerSessionKey = marker
      ? resolvePreferredSessionKeyForSessionIdMatches(
          markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
          marker.sessionId,
        )
      : undefined;
    const markerMappedToRetainedKey = markerMatches.some(
      ({ sessionKey }) => sessionKey === current.sessionKey,
    );
    const markerSessionKey = marker
      ? retainedMarkerEntry?.sessionId === marker.sessionId ||
        (retainedMarkerEntry?.sessionId === current.sessionId &&
          (markerMatches.length === 0 || markerMappedToRetainedKey))
        ? current.sessionKey
        : (preferredMarkerSessionKey ??
          (markerMatches.length === 0 && !retainedMarkerEntry ? current.sessionKey : undefined))
      : undefined;
    const legacyTarget = marker
      ? markerSessionKey
        ? { ...marker, sessionId: marker.sessionId, sessionKey: markerSessionKey }
        : undefined
      : keyedSessionId
        ? { ...current, sessionId: keyedSessionId, sessionKey: successorFile }
        : undefined;
    if (!legacyTarget) {
      throw new Error(
        "Legacy context-engine successor files are unsupported; return a structured sessionTarget",
      );
    }
    const resolvedTarget = await resolveAgentRunSessionTarget({
      agentId: legacyTarget.agentId,
      config: params.config,
      missingSessionKey: "resolve-existing",
      sessionId: legacyTarget.sessionId,
      sessionKey: legacyTarget.sessionKey,
      sessionTarget: legacyTarget,
    });
    assertSameSessionBinding(current, resolvedTarget, "Legacy context-engine");
    return {
      sessionId: resolvedTarget.sessionId,
      sessionFile: marker
        ? formatSqliteSessionFileMarker(resolvedTarget)
        : resolvedTarget.sessionKey,
      sessionTarget: resolvedTarget,
    };
  }

  return {
    sessionId: successorId ?? current.sessionId,
    sessionFile: params.currentSessionFile,
    sessionTarget: successorId ? { ...current, sessionId: successorId } : current,
  };
}

function assertSameSessionBinding(
  currentTarget: SessionTranscriptRuntimeTarget,
  successorTarget: SessionTranscriptRuntimeTarget,
  label: string,
): void {
  if (
    successorTarget.agentId !== currentTarget.agentId ||
    successorTarget.sessionKey !== currentTarget.sessionKey ||
    path.resolve(successorTarget.storePath) !== path.resolve(currentTarget.storePath)
  ) {
    throw new Error(`${label} successor target changed the active session binding`);
  }
}
