import fs from "node:fs/promises";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  resolveSessionTranscriptRuntimeReadTarget,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { resolveQuotaSuspensionEntryMaintenance } from "../../../config/sessions/store-maintenance.js";
import type { SessionEntry as ConfigSessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import { log } from "../logger.js";
import { canContinueFromMessage, trimToContinuableTail } from "./compaction-timeout.js";
import { MID_TURN_PRECHECK_ERROR_MESSAGE } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;

export function flushSessionManagerTranscript(sessionManager: AttemptSessionManager): void {
  sessionManager.flushPendingPersistence();
}

export function repairAttemptToolUseResultPairing(
  messages: AgentMessage[],
  isOpenAIResponsesApi: boolean,
): AgentMessage[] {
  return sanitizeToolUseResultPairing(messages, {
    erroredAssistantResultPolicy: "drop",
    ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
  });
}

function isMidTurnPrecheckAssistantError(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const record = message as unknown as { stopReason?: unknown; errorMessage?: unknown };
  return record.stopReason === "error" && record.errorMessage === MID_TURN_PRECHECK_ERROR_MESSAGE;
}

export function removeTrailingMidTurnPrecheckAssistantError(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: AttemptSessionManager;
}): void {
  const messages = params.activeSession.agent.state.messages;
  const removedActiveError = isMidTurnPrecheckAssistantError(messages.at(-1));
  if (removedActiveError) {
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }

  const removedPersistedError =
    params.sessionManager.removeTrailingEntries(
      (entry) => entry.type === "message" && isMidTurnPrecheckAssistantError(entry.message),
      {
        preserveTrailing: (entry) =>
          entry.type === "custom" ||
          entry.type === "label" ||
          entry.type === "session_info" ||
          (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
      },
    ) > 0;
  if (removedActiveError && !removedPersistedError) {
    log.warn(
      "[context-overflow-midturn-precheck] removed synthetic assistant error from active session but could not locate matching persisted SessionManager entry",
    );
  }
}

export function normalizeCompactionRecoveryTranscriptTail(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: AttemptSessionManager;
}): number {
  const messages = params.activeSession.agent.state.messages;
  const continuableMessages = trimToContinuableTail(messages) ?? [];

  // This is the single recovery owner for compaction exits that hand control
  // back to a continuation. AgentCore rejects assistant tails before providers run.
  const removedEntries = params.sessionManager.removeTrailingEntries(
    (entry) => entry.type === "message" && !canContinueFromMessage(entry.message),
    {
      preserveTrailing: (entry) =>
        entry.type === "custom" ||
        entry.type === "label" ||
        entry.type === "session_info" ||
        (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
    },
  );
  params.activeSession.agent.state.messages =
    removedEntries > 0
      ? params.sessionManager.buildSessionContext().messages
      : continuableMessages.length === messages.length
        ? messages
        : continuableMessages;
  return removedEntries;
}

// Applies quota-resume TTL maintenance to only the active attempt session.
export async function loadAttemptSessionEntryAfterQuotaMaintenance(params: {
  storePath: string;
  sessionKey: string;
}): Promise<ConfigSessionEntry | undefined> {
  const entry = loadSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
  if (!entry?.quotaSuspension) {
    return entry;
  }
  const now = Date.now();
  const maintenance = resolveQuotaSuspensionEntryMaintenance({ entry, now });
  if (!maintenance.patch) {
    return entry;
  }
  const updated = await updateSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    (currentEntry) =>
      resolveQuotaSuspensionEntryMaintenance({
        entry: currentEntry,
        now,
      }).patch,
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
    },
  );
  return updated ?? entry;
}

export async function resolveAttemptTrajectorySessionFile(params: {
  agentId: string;
  config?: OpenClawConfig;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): Promise<string> {
  const storePath =
    params.sessionTarget?.storePath ??
    resolveStorePath(params.config?.session?.store, { agentId: params.agentId });
  if (!storePath || !params.sessionKey) {
    return params.sessionFile;
  }
  return (
    await resolveSessionTranscriptRuntimeReadTarget({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath,
    })
  ).sessionFile;
}

type ExistingAttemptTranscriptState = {
  hasBootstrapTranscriptState: boolean;
  hasFileTranscriptState: boolean;
};

function isTranscriptMessageEvent(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    (event as { type?: unknown }).type === "message"
  );
}

export async function resolveExistingAttemptTranscriptState(params: {
  agentId: string;
  config?: OpenClawConfig;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): Promise<ExistingAttemptTranscriptState> {
  const storePath =
    params.sessionTarget?.storePath ??
    resolveStorePath(params.config?.session?.store, { agentId: params.agentId });
  const sqliteMarker = parseSqliteSessionFileMarker(params.sessionFile);
  let hasBootstrapTranscriptState = false;
  if (storePath && params.sessionKey) {
    try {
      const sqliteEvents = await loadTranscriptEvents({
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath,
      });
      hasBootstrapTranscriptState = sqliteEvents.some(isTranscriptMessageEvent);
      if (sqliteMarker) {
        return {
          hasBootstrapTranscriptState,
          hasFileTranscriptState: false,
        };
      }
    } catch {
      if (sqliteMarker) {
        return {
          hasBootstrapTranscriptState: false,
          hasFileTranscriptState: false,
        };
      }
    }
  }
  const hasFileTranscriptState = await fs
    .stat(params.sessionFile)
    .then(() => true)
    .catch(() => false);
  return {
    hasBootstrapTranscriptState: hasBootstrapTranscriptState || hasFileTranscriptState,
    hasFileTranscriptState,
  };
}
