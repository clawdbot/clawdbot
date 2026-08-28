/** Private-local SDK subpath for memory session transcript helpers. */
import {
  listSessionParticipantsReadOnly,
  listSessionTranscriptArchivesReadOnly as loadArchivedSessions,
  listSessionTranscriptInstances,
  type SessionTranscriptInstance,
} from "../config/sessions/session-accessor.js";
import { normalizeAgentId } from "../routing/session-key.js";

export { loadArchivedSessions };

export {
  buildSessionEntry,
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  isQueryStopWordToken,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionFilesForAgent,
  listSessionTranscriptCorpusEntriesForAgent,
  loadDreamingNarrativeTranscriptPathSetForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  parseCanonicalSessionSyncTargetFromPath,
  parseSqliteSessionFileMarker,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionFileForSyncTarget,
  resolveSessionIdentityForTranscriptFile,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
export type {
  BuildSessionEntryOptions,
  ResolvedMemorySessionSyncTarget,
  ResolvedSessionTranscriptIdentity,
  SessionFileEntry,
  SessionFileState,
  SessionTranscriptClassification,
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

export type MemorySessionTarget = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  resolution: "live" | "archived" | "unresolved";
  hookExternalContentSource: string | null;
  channel: string | null;
  accountId: string | null;
  chatType: string | null;
  createdAt?: number;
  participantIds: string[];
};

export type MemorySessionSelectors = {
  agentId: string;
  storePath?: string;
  sessionIds?: readonly string[];
  hookSources?: readonly string[];
  participants?: readonly string[];
  since?: string | number;
};

function projectSessionMetadata(
  instance: SessionTranscriptInstance,
  participantIds: string[] = [],
): MemorySessionTarget {
  return {
    agentId: instance.agentId,
    sessionId: instance.sessionId,
    sessionKey: instance.sessionKey,
    resolution: "live",
    ...instance.sourceMetadata,
    participantIds,
  };
}

/** Read authoritative admission facts without creating a missing agent database. */
export function loadMemorySessionMetadata(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): MemorySessionTarget | undefined {
  const instance = listSessionTranscriptInstances(params, {
    includeAllWindows: true,
    sessionId: params.sessionId,
  }).find(
    (candidate) =>
      candidate.agentId === normalizeAgentId(params.agentId) &&
      (!params.sessionKey || candidate.sessionKey === params.sessionKey),
  );
  return instance ? projectSessionMetadata(instance) : undefined;
}

/** Resolve explicit memory-forget selectors against authoritative session owners. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  const sessionIds = [...new Set(params.sessionIds ?? [])];
  const hookSources = [...new Set(params.hookSources ?? [])];
  const participants = [...new Set(params.participants ?? [])];
  if (sessionIds.length === 0 && hookSources.length === 0 && participants.length === 0) {
    return [];
  }
  const since = typeof params.since === "string" ? Date.parse(params.since) : params.since;
  if (since !== undefined && !Number.isFinite(since)) {
    throw new Error(`Invalid memory session date: ${params.since}`);
  }
  const resolvedSelectors = new Set<string>();
  const participantRecords = listSessionParticipantsReadOnly(params);
  const targets = new Map<string, MemorySessionTarget>();
  const instances = listSessionTranscriptInstances(params, { includeAllWindows: true })
    .filter((instance) => instance.agentId === normalizeAgentId(params.agentId))
    .toSorted(
      (left, right) =>
        left.sourceMetadata.createdAt - right.sourceMetadata.createdAt ||
        left.sessionId.localeCompare(right.sessionId),
    );
  for (const instance of instances) {
    const participantIds = [
      ...new Set((participantRecords.get(instance.sessionKey) ?? []).map(({ actor }) => actor.id)),
    ].toSorted();
    const source = instance.sourceMetadata.hookExternalContentSource;
    if (
      !sessionIds.includes(instance.sessionId) &&
      !sessionIds.includes(instance.sessionKey) &&
      !(source && hookSources.includes(source)) &&
      !participantIds.some((id) => participants.includes(id))
    ) {
      continue;
    }
    resolvedSelectors.add(instance.sessionId);
    resolvedSelectors.add(instance.sessionKey);
    if (since === undefined || instance.sourceMetadata.createdAt >= since) {
      targets.set(instance.sessionId, projectSessionMetadata(instance, participantIds));
    }
  }
  for (const archive of loadArchivedSessions({ ...params, sessionIds })) {
    resolvedSelectors.add(archive.sessionId);
    resolvedSelectors.add(archive.sessionKey);
    if (targets.has(archive.sessionId) || (since !== undefined && archive.createdAt < since)) {
      continue;
    }
    targets.set(archive.sessionId, {
      agentId: params.agentId,
      sessionId: archive.sessionId,
      sessionKey: archive.sessionKey,
      resolution: "archived",
      hookExternalContentSource: null,
      channel: null,
      accountId: null,
      chatType: null,
      createdAt: archive.createdAt,
      participantIds: [],
    });
  }
  for (const sessionId of sessionIds) {
    if (!resolvedSelectors.has(sessionId)) {
      targets.set(sessionId, {
        agentId: params.agentId,
        sessionId,
        resolution: "unresolved",
        hookExternalContentSource: null,
        channel: null,
        accountId: null,
        chatType: null,
        participantIds: [],
      });
    }
  }
  return [...targets.values()];
}
