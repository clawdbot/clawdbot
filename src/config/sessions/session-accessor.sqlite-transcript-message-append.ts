import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  appendTranscriptEventInTransaction,
  ensureTranscriptHeader,
  readMessageIdempotencyKey,
  readTranscriptIdentityByEventId,
  readTranscriptMessageByEventId,
  readTranscriptMessageByScopedIdempotencyKey,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";

class TranscriptTurnAdmissionConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Transcript idempotency key "${idempotencyKey}" conflicts with the admitted message.`);
    this.name = "TranscriptTurnAdmissionConflictError";
  }
}

function messagesMatchForIdempotentReplay(stored: unknown, candidate: unknown): boolean {
  const serializedShape = (message: unknown): unknown => {
    if (!isRecord(message)) {
      return message;
    }
    const { timestamp: _timestamp, ...stable } = message;
    const serialized = JSON.stringify(stable);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  };
  return isDeepStrictEqual(serializedShape(stored), serializedShape(candidate));
}

export function appendSqliteTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage> & { messageAlreadyRedacted?: boolean },
): TranscriptMessageAppendResult<TMessage> | undefined {
  const serializeForStorage = (message: TMessage): TMessage =>
    options.messageAlreadyRedacted ? message : redactTranscriptMessageForStorage(message, options);
  const readAnchor = (params: {
    message: unknown;
    messageId: string;
  }): TranscriptMessageAppendResult<TMessage>["anchor"] =>
    readActiveTranscriptEntryAnchorInTransaction({
      database,
      resolved,
      entryId: params.messageId,
      message: params.message,
    });
  const existingAppendResult = (found: { message: unknown; messageId: string }) => {
    const anchor = readAnchor(found);
    return {
      appended: false as const,
      ...(anchor ? { anchor } : {}),
      effectiveParentId:
        readTranscriptIdentityByEventId(database, resolved.sessionId, found.messageId)?.parentId ??
        null,
      message: found.message as TMessage,
      messageId: found.messageId,
    };
  };
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      if (
        !options.prepareMessageAfterIdempotencyCheck &&
        !messagesMatchForIdempotentReplay(existing.message, serializeForStorage(options.message))
      ) {
        throw new TranscriptTurnAdmissionConflictError(idempotencyKey);
      }
      return existingAppendResult(existing);
    }
  }

  const prepared = options.prepareMessageAfterIdempotencyCheck
    ? options.prepareMessageAfterIdempotencyCheck(options.message)
    : options.message;
  if (prepared === undefined) {
    return undefined;
  }

  const messageId = options.eventId ?? randomUUID();
  const now = options.now ?? Date.now();
  const finalMessage = serializeForStorage(prepared);
  ensureTranscriptHeader(database, resolved, options.cwd, now);
  const parentId = resolveTranscriptMessageAppendParent(database, resolved.sessionId, options);
  const event = {
    type: "message",
    id: messageId,
    parentId: parentId ?? null,
    timestamp: resolveTimestampMsToIsoString(now),
    message: finalMessage,
  };
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    dedupeByMessageIdempotency:
      options.idempotencyLookup !== "caller-checked" &&
      options.idempotencyLookup !== "scan-assistant",
  });
  if (!appended && idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      if (
        !options.prepareMessageAfterIdempotencyCheck &&
        !messagesMatchForIdempotentReplay(existing.message, finalMessage)
      ) {
        throw new TranscriptTurnAdmissionConflictError(idempotencyKey);
      }
      return existingAppendResult(existing);
    }
  }
  if (!appended) {
    const existing = readTranscriptMessageByEventId(database, resolved, messageId);
    if (existing) {
      if (
        !options.prepareMessageAfterIdempotencyCheck &&
        !messagesMatchForIdempotentReplay(existing.message, finalMessage)
      ) {
        throw new TranscriptTurnAdmissionConflictError(idempotencyKey ?? `event:${messageId}`);
      }
      return existingAppendResult(existing);
    }
  }
  if (!appended) {
    throw new Error(`SQLite transcript append did not insert message ${messageId}.`);
  }
  const anchor = readAnchor({ message: finalMessage, messageId });
  return {
    appended: true,
    ...(anchor ? { anchor } : {}),
    effectiveParentId: parentId ?? null,
    message: finalMessage,
    messageId,
  };
}
