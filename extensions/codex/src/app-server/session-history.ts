/** Reads model context separately from full-fidelity Codex mirror evidence. */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  getSessionEntry,
  parseSqliteSessionFileMarker,
  resolveTranscriptSessionKeyBySessionId,
  type SqliteSessionFileMarker,
} from "openclaw/plugin-sdk/session-store-runtime";
import type {
  TranscriptTurnAdmission,
  SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  consumeCodexHistory,
  readCodexNativeHistory,
  type ResolvedCodexHistoryTarget,
} from "./session-history-read.js";

type CodexHistoryView = "native-evidence" | "model-context";
export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: Partial<SessionTranscriptTargetParams>;
};

export function resolveCodexHistoryTarget(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
): ResolvedCodexHistoryTarget {
  if (target.sessionTarget) {
    const { agentId, sessionId, sessionKey, storePath } = target.sessionTarget;
    if (
      !agentId ||
      !sessionId ||
      !sessionKey ||
      !storePath ||
      sessionId !== target.sessionId ||
      (target.agentId !== undefined && agentId !== target.agentId) ||
      (target.sessionKey !== undefined && sessionKey !== target.sessionKey)
    ) {
      return { kind: "empty" };
    }
    return { kind: "sqlite", target: { agentId, sessionId, sessionKey, storePath } };
  }
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== target.sessionId ||
      (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
    ) {
      return { kind: "empty" };
    }
    const sessionKey = resolveSqliteMarkerSessionKey(target, sqliteMarker);
    return sessionKey
      ? {
          kind: "sqlite",
          target: {
            agentId: sqliteMarker.agentId,
            sessionId: sqliteMarker.sessionId,
            sessionKey,
            storePath: sqliteMarker.storePath,
          },
        }
      : { kind: "empty" };
  }
  if (admission) {
    if (
      admission.sessionId !== target.sessionId ||
      (target.agentId !== undefined && admission.agentId !== target.agentId) ||
      (target.sessionKey !== undefined && admission.sessionKey !== target.sessionKey)
    ) {
      return { kind: "empty" };
    }
    return {
      kind: "sqlite",
      target: {
        agentId: admission.agentId,
        sessionId: admission.sessionId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      },
    };
  }
  return { kind: "file", sessionFile: target.sessionFile };
}

/** Returns sanitized session-context messages for consumers that need an owned array. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
  view: CodexHistoryView = "native-evidence",
  signal?: AbortSignal,
): Promise<AgentMessage[] | undefined> {
  signal?.throwIfAborted();
  try {
    let result: AgentMessage[] | undefined;
    if (view === "native-evidence") {
      const { readCodexHistoryMessagesInWorker } =
        await import("../../session-history-worker-runtime.js");
      result = await readCodexHistoryMessagesInWorker(target, admission, signal);
    } else {
      const resolved = resolveCodexHistoryTarget(target, admission);
      const read = (messages: Iterable<AgentMessage>) => Array.from(messages);
      if (resolved.kind === "sqlite") {
        const loaded = await SessionManager.openModelContextAsync(resolved.target, {
          admission,
          signal,
        });
        result = consumeCodexHistory(
          loaded.buildSessionContext().messages,
          loaded.getHeader(),
          target.sessionId,
          read,
          "codex mirrored model context",
        );
      } else {
        const history = await readCodexNativeHistory(resolved, target.sessionId, read, admission);
        result = history.status === "ok" ? history.value : undefined;
      }
    }
    signal?.throwIfAborted();
    return result;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function resolveSqliteMarkerSessionKey(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): string | undefined {
  const explicitSessionKey = target.sessionKey?.trim();
  if (explicitSessionKey) {
    // The SDK exact-entry accessor uses a read-only database handle.
    const explicitEntry = getSessionEntry({
      agentId: marker.agentId,
      sessionKey: explicitSessionKey,
      storePath: marker.storePath,
    });
    if (explicitEntry) {
      return explicitEntry.sessionId === marker.sessionId ? explicitSessionKey : undefined;
    }
  }
  return resolveTranscriptSessionKeyBySessionId({
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    storePath: marker.storePath,
  });
}
