import fs from "node:fs";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  updateSessionStore,
} from "../../config/sessions.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";

type ResetSessionOptions = {
  failureLabel: string;
  buildLogMessage: (nextSessionId: string) => string;
  cleanupTranscripts?: boolean;
};

const deps = {
  generateSecureUuid,
  updateSessionStore,
  refreshQueuedFollowupSession,
  error: (message: string) => defaultRuntime.error(message),
};

export function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void {
  Object.assign(deps, {
    generateSecureUuid,
    updateSessionStore,
    refreshQueuedFollowupSession,
    error: (message: string) => defaultRuntime.error(message),
    ...overrides,
  });
}

export async function resetReplyRunSession(params: {
  options: ResetSessionOptions;
  sessionKey?: string;
  queueKey: string;
  activeSessionEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  messageThreadId?: string;
  followupRun: FollowupRun;
  onActiveSessionEntry: (entry: SessionEntry) => void;
  onNewSession: (newSessionId: string, nextSessionFile: string) => void;
}): Promise<boolean> {
  if (!params.sessionKey || !params.activeSessionStore || !params.storePath) {
    return false;
  }
  const prevEntry = params.activeSessionStore[params.sessionKey] ?? params.activeSessionEntry;
  if (!prevEntry) {
    return false;
  }
  const prevSessionId = params.options.cleanupTranscripts ? prevEntry.sessionId : undefined;
  const nextSessionId = deps.generateSecureUuid();
  const now = Date.now();
  const nextEntry: SessionEntry = {
    ...prevEntry,
    sessionId: nextSessionId,
    updatedAt: now,
    sessionStartedAt: now,
    lastInteractionAt: now,
    systemSent: false,
    abortedLastRun: false,
    modelProvider: undefined,
    model: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    totalTokensFresh: false,
    estimatedCostUsd: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    contextTokens: undefined,
    systemPromptReport: undefined,
    fallbackNoticeSelectedModel: undefined,
    fallbackNoticeActiveModel: undefined,
    fallbackNoticeReason: undefined,
  };
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const nextSessionFile = resolveSessionTranscriptPath(
    nextSessionId,
    agentId,
    params.messageThreadId,
  );
  nextEntry.sessionFile = nextSessionFile;
  params.activeSessionStore[params.sessionKey] = nextEntry;
  try {
    await deps.updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey!] = nextEntry;
    });
  } catch (err) {
    deps.error(
      `Failed to persist session reset after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`,
    );
  }
  params.followupRun.run.sessionId = nextSessionId;
  params.followupRun.run.sessionFile = nextSessionFile;
  deps.refreshQueuedFollowupSession({
    key: params.queueKey,
    previousSessionId: prevEntry.sessionId,
    nextSessionId,
    nextSessionFile,
  });
  params.onActiveSessionEntry(nextEntry);
  params.onNewSession(nextSessionId, nextSessionFile);
  deps.error(params.options.buildLogMessage(nextSessionId));
  if (params.options.cleanupTranscripts && prevSessionId) {
    const transcriptCandidates = new Set<string>();
    const resolved = resolveSessionFilePath(
      prevSessionId,
      prevEntry,
      resolveSessionFilePathOptions({ agentId, storePath: params.storePath }),
    );
    if (resolved) {
      transcriptCandidates.add(resolved);
    }
    transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
    for (const candidate of transcriptCandidates) {
      try {
        fs.unlinkSync(candidate);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  return true;
}
