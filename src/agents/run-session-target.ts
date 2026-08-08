import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  listSessionEntries,
  resolveTranscriptSessionKeyBySessionId,
  resolveSessionTranscriptRuntimeTarget,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { resolveDefaultAgentId } from "./agent-scope.js";

/** Identifies a run transcript target without naming the current storage artifact. */
export type AgentRunSessionTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  threadId?: string | number;
};

/** Canonical SQLite target resolved from the storage-neutral run identity. */
type ResolvedAgentRunSessionTarget = SessionTranscriptRuntimeTarget;

class AgentRunSessionTargetResolutionError extends Error {
  readonly code = "session-key-missing";

  constructor(sessionId: string) {
    super(`Cannot resolve a session key for existing session: ${sessionId}`);
    this.name = "AgentRunSessionTargetResolutionError";
  }
}

/** Resolves the active runtime target used by current run/session internals. */
export async function resolveAgentRunSessionTarget(params: {
  agentId?: string;
  config?: OpenClawConfig;
  missingSessionKey: "create" | "resolve-existing";
  sessionId: string;
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: AgentRunSessionTarget;
}): Promise<ResolvedAgentRunSessionTarget> {
  const config = params.config ?? getRuntimeConfig();
  const sessionTarget = params.sessionTarget;
  const targetAgentId = normalizeOptionalString(sessionTarget?.agentId);
  const targetSessionId = normalizeOptionalString(sessionTarget?.sessionId);
  const targetSessionKey = normalizeOptionalString(sessionTarget?.sessionKey);
  const targetStorePath = normalizeOptionalString(sessionTarget?.storePath);
  const hasCompleteTypedTarget = Boolean(
    targetAgentId && targetSessionId && targetSessionKey && targetStorePath,
  );
  const legacySessionFile = normalizeOptionalString(params.sessionFile);
  const suppliedSessionKey = normalizeOptionalString(params.sessionKey);
  const legacyMarker = parseSqliteSessionFileMarker(legacySessionFile);
  const recognizedCompatibilityKey = Boolean(
    legacySessionFile?.startsWith("agent:") || legacySessionFile?.startsWith("in-memory:"),
  );
  const fileBackedCompatibilityValue = Boolean(
    legacySessionFile &&
    !recognizedCompatibilityKey &&
    (path.isAbsolute(legacySessionFile) ||
      legacySessionFile.includes("/") ||
      legacySessionFile.includes("\\") ||
      legacySessionFile.endsWith(".jsonl")),
  );
  const plainCompatibilitySessionKey =
    !fileBackedCompatibilityValue && legacySessionFile === (targetSessionId ?? params.sessionId)
      ? legacySessionFile
      : undefined;
  if (
    !hasCompleteTypedTarget &&
    legacySessionFile &&
    !legacyMarker &&
    (fileBackedCompatibilityValue ||
      (!plainCompatibilitySessionKey &&
        !recognizedCompatibilityKey &&
        legacySessionFile !== suppliedSessionKey &&
        legacySessionFile !== targetSessionKey))
  ) {
    throw new Error(
      "File-backed transcript targets are unsupported; migrate the session to SQLite first",
    );
  }
  const agentId = targetAgentId ?? legacyMarker?.agentId ?? params.agentId;
  const sessionId = targetSessionId ?? legacyMarker?.sessionId ?? params.sessionId;
  const recognizedCompatibilitySessionKey = recognizedCompatibilityKey
    ? legacySessionFile
    : undefined;
  const compatibilitySessionKey =
    recognizedCompatibilitySessionKey ??
    (params.missingSessionKey === "create" ? plainCompatibilitySessionKey : undefined);
  const markerEntries =
    legacyMarker && !hasCompleteTypedTarget
      ? listSessionEntries({
          agentId: legacyMarker.agentId,
          storePath: legacyMarker.storePath,
        })
      : [];
  const markerMatches = legacyMarker
    ? markerEntries.filter(({ entry }) => entry.sessionId === legacyMarker.sessionId)
    : [];
  const markerSessionKey =
    legacyMarker && !hasCompleteTypedTarget
      ? resolvePreferredSessionKeyForSessionIdMatches(
          markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
          legacyMarker.sessionId,
        )
      : undefined;
  if (
    legacyMarker &&
    !hasCompleteTypedTarget &&
    !targetSessionKey &&
    !suppliedSessionKey &&
    markerMatches.length > 0 &&
    !markerSessionKey
  ) {
    throw new Error("Legacy SQLite transcript marker session key is ambiguous");
  }
  const lookupAgentId = agentId ?? resolveDefaultAgentId(config);
  const lookupStorePath =
    targetStorePath ??
    legacyMarker?.storePath ??
    resolveStorePath(config.session?.store, { agentId: lookupAgentId });
  const storedSessionKey =
    params.missingSessionKey === "resolve-existing" &&
    !targetSessionKey &&
    !suppliedSessionKey &&
    !compatibilitySessionKey &&
    !markerSessionKey
      ? resolveTranscriptSessionKeyBySessionId({
          agentId: lookupAgentId,
          sessionId,
          storePath: lookupStorePath,
        })
      : undefined;
  const createdSessionKey =
    params.missingSessionKey === "create"
      ? toAgentStoreSessionKey({ agentId: lookupAgentId, requestKey: sessionId })
      : undefined;
  const sessionKey =
    targetSessionKey ??
    suppliedSessionKey ??
    compatibilitySessionKey ??
    markerSessionKey ??
    storedSessionKey ??
    createdSessionKey;
  const compatibilitySessionKeySelected =
    !targetSessionKey && !suppliedSessionKey && sessionKey === compatibilitySessionKey;
  const suppliedKeyAgentId = parseAgentSessionKey(suppliedSessionKey)?.agentId;
  const targetKeyAgentId = parseAgentSessionKey(targetSessionKey)?.agentId;
  const compatibilityKeyAgentId = parseAgentSessionKey(compatibilitySessionKey)?.agentId;
  const candidateMarkerKey = targetSessionKey ?? suppliedSessionKey;
  const candidateMarkerEntry = candidateMarkerKey
    ? markerEntries.find(({ sessionKey: candidateKey }) => candidateKey === candidateMarkerKey)
        ?.entry
    : undefined;
  if (
    legacyMarker &&
    !hasCompleteTypedTarget &&
    ((targetAgentId && targetAgentId !== legacyMarker.agentId) ||
      (targetSessionId && targetSessionId !== legacyMarker.sessionId) ||
      (params.agentId && params.agentId !== legacyMarker.agentId) ||
      (targetKeyAgentId && targetKeyAgentId !== legacyMarker.agentId) ||
      (suppliedKeyAgentId && suppliedKeyAgentId !== legacyMarker.agentId) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(legacyMarker.storePath)))
  ) {
    throw new Error("Legacy SQLite transcript marker conflicts with the supplied session identity");
  }
  if (
    legacyMarker &&
    !hasCompleteTypedTarget &&
    candidateMarkerKey &&
    candidateMarkerEntry &&
    candidateMarkerEntry.sessionId !== legacyMarker.sessionId
  ) {
    throw new Error("Legacy SQLite transcript marker conflicts with the supplied session key");
  }
  if (
    compatibilitySessionKeySelected &&
    compatibilityKeyAgentId &&
    agentId &&
    compatibilityKeyAgentId !== agentId
  ) {
    throw new Error("Compatibility session key conflicts with the supplied agent identity");
  }
  if (!sessionKey) {
    throw new AgentRunSessionTargetResolutionError(sessionId);
  }
  const effectiveAgentId =
    agentId ?? resolveAgentIdFromSessionKey(sessionKey, resolveDefaultAgentId(config));
  if (sessionTarget && sessionKey) {
    const storePath =
      targetStorePath ??
      legacyMarker?.storePath ??
      resolveStorePath(config.session?.store, { agentId: effectiveAgentId });
    return await resolveSessionTranscriptRuntimeTarget({
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      sessionId,
      sessionKey,
      storePath,
      ...(sessionTarget.threadId !== undefined ? { threadId: sessionTarget.threadId } : {}),
    });
  }

  if (legacyMarker && sessionKey) {
    return await resolveSessionTranscriptRuntimeTarget({
      agentId: legacyMarker.agentId,
      sessionId,
      sessionKey,
      storePath: legacyMarker.storePath,
    });
  }

  const storePath = resolveStorePath(config.session?.store, { agentId: effectiveAgentId });
  return await resolveSessionTranscriptRuntimeTarget({
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    sessionId,
    sessionKey,
    storePath,
  });
}

/** Applies identity fields from the explicit target before legacy backfills run. */
export function applyAgentRunSessionTargetIdentity<
  T extends {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: AgentRunSessionTarget;
  },
>(params: T): T {
  const target = params.sessionTarget;
  if (!target) {
    return params;
  }
  return {
    ...params,
    agentId: normalizeOptionalString(target.agentId) ?? params.agentId,
    sessionId: normalizeOptionalString(target.sessionId) ?? params.sessionId,
    sessionKey: normalizeOptionalString(target.sessionKey) ?? params.sessionKey,
  };
}
