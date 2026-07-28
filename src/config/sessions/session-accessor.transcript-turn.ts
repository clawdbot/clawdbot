import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { updateSessionEntry } from "./session-accessor.entry-mutation.js";
import {
  loadSessionEntry,
  resolveSessionEntryFromStore,
  resolveSessionEntrySelection,
} from "./session-accessor.entry.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import { appendSqliteExpectedSessionTranscriptTurn } from "./session-accessor.sqlite.js";
import { shouldUseExplicitTranscriptFile } from "./session-accessor.transcript-target.js";
import { appendTranscriptMessage, emitTranscriptUpdate } from "./session-accessor.transcript.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
  SessionTranscriptTurnUpdateMode,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptTurnPersistOptions,
  SessionTranscriptTurnPersistResult,
} from "./session-accessor.types.js";
import { formatSqliteSessionFileMarker, parseSqliteSessionFileMarker } from "./sqlite-marker.js";
import { runWithOwnedSessionTranscriptWriteLock } from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

/** Appends one prepared ordered group in the existing transcript turn transaction. */
export async function appendTranscriptMessages<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: Pick<SessionTranscriptTurnPersistOptions, "config" | "cwd"> & {
    messages: readonly Omit<
      SessionTranscriptTurnMessageAppend,
      "config" | "cwd" | "parentId" | "prepareMessageAfterIdempotencyCheck" | "shouldAppend"
    >[];
  },
): Promise<TranscriptMessageAppendResult<TMessage>[]> {
  if (options.messages.length === 0) {
    return [];
  }
  const expectedSessionId = scope.sessionId?.trim();
  if (!expectedSessionId) {
    throw new Error("Cannot append a transcript batch without an exact session id");
  }
  const turn = await persistExpectedSessionTranscriptTurn(scope, {
    atomicGroup: true,
    config: options.config,
    cwd: options.cwd,
    expectedSessionId,
    messages: options.messages.map((append) => ({
      ...append,
      eventId: append.eventId ?? randomUUID(),
      message: redactTranscriptMessageForStorage(append.message, options),
      now: append.now ?? Date.now(),
    })),
    updateMode: "none",
  });
  if (turn.rejectedReason) {
    throw new Error("Transcript session changed before batch append");
  }
  return turn.messages as TranscriptMessageAppendResult<TMessage>[];
}

/**
 * Persists one logical transcript turn through the SQLite-backed session target.
 * Transcript row append(s), the synthetic sessionFile marker, and the requested
 * updatedAt touch happen before transcript update delivery is published.
 */
export async function persistSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  options: SessionTranscriptTurnPersistOptions,
): Promise<SessionTranscriptTurnPersistResult> {
  const expectedSessionId = options.expectedSessionId;
  if (expectedSessionId) {
    return await persistExpectedSessionTranscriptTurn(scope, { ...options, expectedSessionId });
  }
  if (options.sessionLifecyclePatch) {
    throw new Error("Cannot patch session lifecycle without an expected session id");
  }
  const target = await resolveTranscriptTurnTarget(scope, options.config);
  const appendedMessages = await runWithOwnedSessionTranscriptWriteLock(
    {
      sessionFile: target.sessionFile,
      sessionKey: target.sessionKey,
    },
    () => appendTranscriptTurnMessages(target, options),
  );
  const appendedCount = countAppendedTranscriptMessages(appendedMessages);
  const sessionEntry = await touchTranscriptTurnSessionEntry({
    scope,
    target,
    shouldTouch: options.touchSessionEntry === true && appendedCount > 0,
  });
  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages,
  });

  return {
    appendedCount,
    messages: appendedMessages,
    sessionEntry,
    sessionFile: target.sessionFile,
  };
}

async function appendTranscriptTurnMessages(
  target: SessionTranscriptTurnWriteContext,
  options: SessionTranscriptTurnPersistOptions,
): Promise<TranscriptMessageAppendResult<unknown>[]> {
  const selectedMessages = await selectAppendableTranscriptTurnMessages(target, options);
  const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
  for (const append of selectedMessages) {
    const { shouldAppend: _shouldAppend, ...appendOptions } = append;
    const result = await appendTranscriptMessage(
      {
        ...(target.agentId ? { agentId: target.agentId } : {}),
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
        ...(target.storePath ? { storePath: target.storePath } : {}),
      },
      {
        ...appendOptions,
        ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
        ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
      },
    );
    if (result) {
      appendedMessages.push(result);
    }
  }
  return appendedMessages;
}

async function selectAppendableTranscriptTurnMessages(
  target: SessionTranscriptTurnWriteContext,
  options: SessionTranscriptTurnPersistOptions,
): Promise<SessionTranscriptTurnMessageAppend[]> {
  const selectedMessages: SessionTranscriptTurnMessageAppend[] = [];
  for (const append of options.messages) {
    const shouldAppend = append.shouldAppend
      ? await append.shouldAppend({
          ...(target.agentId ? { agentId: target.agentId } : {}),
          sessionFile: target.sessionFile,
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
          ...(target.storePath ? { storePath: target.storePath } : {}),
        })
      : true;
    if (!shouldAppend) {
      continue;
    }
    selectedMessages.push(append);
  }
  return selectedMessages;
}

function countAppendedTranscriptMessages(
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): number {
  return messages.filter((message) => message.appended).length;
}

async function persistExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  options: SessionTranscriptTurnPersistOptions & {
    atomicGroup?: boolean;
    expectedSessionId: string;
  },
): Promise<SessionTranscriptTurnPersistResult> {
  const sessionKey = scope.sessionKey?.trim();
  if (!scope.storePath || !sessionKey) {
    throw new Error("Cannot guard a transcript turn without a session store and key");
  }
  const storePath = scope.storePath;
  const expectedSessionId = options.expectedSessionId;
  const agentId =
    scope.agentId ??
    resolveAgentIdFromSessionKey(
      sessionKey,
      resolveDefaultAgentId(options.config ?? getRuntimeConfig()),
    );
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const resolved = scope.sessionStore
    ? resolveSessionEntryFromStore({ store: scope.sessionStore, sessionKey })
    : resolveSessionEntrySelection({
        agentId,
        ...(scope.env ? { env: scope.env } : {}),
        sessionKey,
        storePath,
      });
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: expectedSessionId,
    storePath,
  });
  const target: SessionTranscriptTurnWriteContext = {
    agentId,
    sessionFile,
    sessionId: expectedSessionId,
    sessionKey: resolved.normalizedKey,
    storePath,
  };
  const turn = await runWithOwnedSessionTranscriptWriteLock(
    {
      sessionFile: target.sessionFile,
      sessionKey: target.sessionKey,
    },
    () =>
      appendSqliteExpectedSessionTranscriptTurn(
        {
          agentId,
          sessionKey: resolved.normalizedKey,
          sessionId: expectedSessionId,
          storePath,
        },
        {
          config: options.config,
          cwd: options.cwd,
          expectedLifecycleRevision: options.expectedLifecycleRevision,
          expectedSessionState: options.expectedSessionState,
          expectedSessionId,
          atomicGroup: options.atomicGroup,
          messages: options.messages,
          sessionLifecyclePatch: options.sessionLifecyclePatch,
          sessionFile: target.sessionFile,
          touchSessionEntry: options.touchSessionEntry,
        },
      ),
  );

  if (turn.rejectedReason === "session-rebound") {
    return {
      appendedCount: 0,
      messages: [],
      rejectedReason: "session-rebound",
      sessionEntry: turn.sessionEntry,
      sessionFile: turn.sessionFile,
    };
  }

  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages: turn.appendedMessages,
  });

  if (turn.sessionEntry && scope.sessionStore) {
    scope.sessionStore[resolved.normalizedKey] = turn.sessionEntry;
  }
  return {
    appendedCount: countAppendedTranscriptMessages(turn.appendedMessages),
    messages: turn.appendedMessages,
    sessionEntry: turn.sessionEntry ?? scope.sessionEntry,
    sessionFile: turn.sessionFile,
  };
}

async function resolveTranscriptTurnTarget(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  config?: import("../types.openclaw.js").OpenClawConfig,
): Promise<
  SessionTranscriptTurnWriteContext & {
    sessionEntry: SessionEntry | undefined;
  }
> {
  if (shouldUseExplicitTranscriptFile(scope)) {
    const marker = parseSqliteSessionFileMarker(scope.sessionFile);
    const agentId = scope.agentId ?? marker?.agentId;
    const sessionId = scope.sessionId ?? marker?.sessionId;
    const storePath = scope.storePath ?? marker?.storePath;
    return {
      ...(agentId ? { agentId } : {}),
      sessionFile: scope.sessionFile.trim(),
      ...(sessionId ? { sessionId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
      ...(storePath ? { storePath } : {}),
      sessionEntry: scope.sessionEntry,
    };
  }
  const sessionKey = scope.sessionKey?.trim();
  if (!sessionKey || !scope.sessionId) {
    throw new Error(
      "Cannot persist a transcript turn without a session key and session id or explicit session file",
    );
  }
  const agentId =
    scope.agentId ??
    resolveAgentIdFromSessionKey(sessionKey, resolveDefaultAgentId(config ?? getRuntimeConfig()));
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const storePath =
    scope.storePath ??
    resolveStorePath(getRuntimeConfig().session?.store, {
      agentId,
      env: scope.env,
    });
  const resolved = scope.sessionStore
    ? resolveSessionEntryFromStore({ store: scope.sessionStore, sessionKey })
    : resolveSessionEntrySelection({
        agentId,
        ...(scope.env ? { env: scope.env } : {}),
        sessionKey,
        storePath,
      });
  const sessionEntry =
    resolved?.existing ??
    scope.sessionEntry ??
    loadSessionEntry({ ...scope, agentId, sessionKey, storePath });
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: scope.sessionId,
    storePath,
  });
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    sessionKey: resolved?.normalizedKey ?? sessionKey,
    storePath,
    sessionEntry,
  };
}

async function touchTranscriptTurnSessionEntry(params: {
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  };
  target: SessionTranscriptTurnWriteContext & {
    sessionEntry: SessionEntry | undefined;
  };
  shouldTouch: boolean;
}): Promise<SessionEntry | undefined> {
  if (
    !params.shouldTouch ||
    !params.target.storePath ||
    !params.target.sessionKey ||
    !params.target.sessionId
  ) {
    return params.target.sessionEntry;
  }
  const markerUpdatedAt = Date.now();
  const updated = await updateSessionEntry(
    {
      sessionKey: params.target.sessionKey,
      storePath: params.target.storePath,
      ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    },
    (current) =>
      current.sessionId === params.target.sessionId
        ? {
            sessionFile: params.target.sessionFile,
            updatedAt: Math.max(current.updatedAt ?? 0, markerUpdatedAt),
          }
        : null,
    { skipMaintenance: true },
  );
  if (updated && params.scope.sessionStore) {
    params.scope.sessionStore[params.target.sessionKey] = updated;
  }
  return updated ?? params.target.sessionEntry;
}

async function publishTranscriptTurnUpdate(params: {
  target: SessionTranscriptTurnWriteContext;
  updateMode: SessionTranscriptTurnUpdateMode;
  publishWhen: "always" | "when-appended";
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
}): Promise<void> {
  if (params.updateMode === "none") {
    return;
  }
  const lastAppended = params.appendedMessages.findLast((message) => message.appended);
  if (params.publishWhen === "when-appended" && !lastAppended) {
    return;
  }
  const target =
    params.target.agentId && params.target.sessionId && params.target.sessionKey
      ? {
          agentId: params.target.agentId,
          sessionId: params.target.sessionId,
          sessionKey: params.target.sessionKey,
        }
      : undefined;
  emitTranscriptUpdate({
    ...(params.target.sessionKey ? { sessionKey: params.target.sessionKey } : {}),
    ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    ...(target ? { target } : {}),
    ...(params.updateMode === "inline" && lastAppended
      ? {
          message: lastAppended.message,
          messageId: lastAppended.messageId,
        }
      : {}),
    sessionFile: params.target.sessionFile,
  });
}
