import path from "node:path";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../../sessions/session-id-resolution.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;

export function applyEmbeddedAttemptSessionIdentity(params: {
  sessionPromptState: Pick<
    SessionPromptState,
    "adoptSessionId" | "sessionFile" | "sessionId" | "sessionTarget"
  >;
  sessionFileUsed?: string;
  sessionIdUsed: string;
}): void {
  const { sessionPromptState, sessionFileUsed, sessionIdUsed } = params;
  const previousSessionId = sessionPromptState.sessionId;
  let adoptedSessionId = sessionIdUsed;
  const sessionFileChanged = Boolean(
    sessionFileUsed && sessionFileUsed !== sessionPromptState.sessionFile,
  );
  let nextSessionTarget = sessionPromptState.sessionTarget;
  if (sessionFileUsed && sessionFileChanged) {
    const marker = parseSqliteSessionFileMarker(sessionFileUsed);
    if (marker) {
      const retainedSessionKey = sessionPromptState.sessionTarget?.sessionKey;
      const retainedEntry = retainedSessionKey
        ? loadSessionEntry({
            agentId: marker.agentId,
            sessionKey: retainedSessionKey,
            storePath: marker.storePath,
          })
        : undefined;
      const markerMatches = listSessionEntriesCore({
        agentId: marker.agentId,
        storePath: marker.storePath,
      }).filter(({ entry }) => entry.sessionId === marker.sessionId);
      const preferredMarkerSessionKey = resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      );
      const markerMappedToRetainedKey = markerMatches.some(
        ({ sessionKey }) => sessionKey === retainedSessionKey,
      );
      const successorSessionKey =
        retainedEntry?.sessionId === marker.sessionId ||
        (retainedEntry?.sessionId === previousSessionId &&
          (markerMatches.length === 0 || markerMappedToRetainedKey))
          ? retainedSessionKey
          : (preferredMarkerSessionKey ??
            (markerMatches.length === 0 && !retainedEntry ? retainedSessionKey : undefined));
      if (
        (marker.sessionId !== sessionIdUsed && sessionIdUsed !== previousSessionId) ||
        !successorSessionKey ||
        marker.agentId !== sessionPromptState.sessionTarget?.agentId
      ) {
        throw new Error("Legacy context-engine successor identity is inconsistent");
      }
      adoptedSessionId = marker.sessionId;
      nextSessionTarget = {
        ...marker,
        sessionKey: successorSessionKey,
      };
    } else if (
      sessionFileUsed.startsWith("agent:") &&
      sessionPromptState.sessionTarget &&
      resolveAgentIdFromSessionKey(sessionFileUsed) === sessionPromptState.sessionTarget.agentId
    ) {
      const keyedEntry = loadSessionEntry({
        agentId: sessionPromptState.sessionTarget.agentId,
        sessionKey: sessionFileUsed,
        storePath: sessionPromptState.sessionTarget.storePath,
      });
      if (!keyedEntry?.sessionId || keyedEntry.sessionId !== sessionIdUsed) {
        throw new Error("Legacy context-engine successor identity is inconsistent");
      }
      nextSessionTarget = {
        ...sessionPromptState.sessionTarget,
        sessionId: sessionIdUsed,
        sessionKey: sessionFileUsed,
      };
    } else {
      throw new Error(
        "Legacy context-engine successor files are unsupported; return a structured sessionTarget",
      );
    }
  } else if (sessionIdUsed && sessionIdUsed !== previousSessionId) {
    nextSessionTarget = sessionPromptState.sessionTarget
      ? { ...sessionPromptState.sessionTarget, sessionId: sessionIdUsed }
      : undefined;
  }
  if (
    sessionFileChanged &&
    nextSessionTarget &&
    sessionPromptState.sessionTarget &&
    (!nextSessionTarget.agentId ||
      !nextSessionTarget.sessionKey ||
      !nextSessionTarget.storePath ||
      !sessionPromptState.sessionTarget.agentId ||
      !sessionPromptState.sessionTarget.sessionKey ||
      !sessionPromptState.sessionTarget.storePath ||
      nextSessionTarget.agentId !== sessionPromptState.sessionTarget.agentId ||
      nextSessionTarget.sessionKey !== sessionPromptState.sessionTarget.sessionKey ||
      path.resolve(nextSessionTarget.storePath) !==
        path.resolve(sessionPromptState.sessionTarget.storePath))
  ) {
    throw new Error("Legacy context-engine successor target changed the active session binding");
  }
  sessionPromptState.adoptSessionId(adoptedSessionId);
  if (sessionFileUsed && sessionFileChanged) {
    sessionPromptState.sessionFile = sessionFileUsed;
  } else if (adoptedSessionId !== previousSessionId && nextSessionTarget) {
    const marker = parseSqliteSessionFileMarker(sessionPromptState.sessionFile);
    if (marker) {
      sessionPromptState.sessionFile = formatSqliteSessionFileMarker({
        agentId: nextSessionTarget.agentId ?? marker.agentId,
        sessionId: nextSessionTarget.sessionId ?? marker.sessionId,
        storePath: nextSessionTarget.storePath ?? marker.storePath,
      });
    }
  }
  sessionPromptState.sessionTarget = nextSessionTarget;
}
