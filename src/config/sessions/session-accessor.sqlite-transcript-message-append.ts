import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  consumeSessionPendingInput,
  resolveSessionPendingInputAppend,
} from "./session-accessor.sqlite-pending-inputs.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  appendTranscriptEventInTransaction,
  ensureTranscriptHeader,
  readMessageIdempotencyKey,
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

export function appendTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage> & { messageAlreadyRedacted?: boolean },
): TranscriptMessageAppendResult<TMessage> | undefined {
  const pending = resolveSessionPendingInputAppend(database, resolved, options.message);
  if (
    pending &&
    readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !== resolved.sessionId
  ) {
    throw new Error("Pending input session changed before transcript promotion");
  }
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
    if (pending) {
      if (
        found.messageId !== pending.inputId ||
        !messagesMatchForIdempotentReplay(found.message, pending.message)
      ) {
        throw new TranscriptTurnAdmissionConflictError(pending.inputId);
      }
      // A consumed receipt permits terminal mirroring only while its exact user
      // remains on the active path; it cannot revive a replaced transcript branch.
      if (!anchor) {
        throw new Error("Pending input is no longer active in its admitted transcript");
      }
      consumeSessionPendingInput(database, pending);
    }
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

  if (pending?.alreadyPromoted && !pending.commitRelocation) {
    const committed = readTranscriptMessageByEventId(database, resolved, pending.inputId);
    if (!committed) {
      throw new Error("Pending input custody ended before transcript promotion");
    }
    return existingAppendResult(committed);
  }
  // Pending input already passed the hook and redaction before acknowledgment.
  const prepared = pending
    ? (pending.message as TMessage) // SAFETY: exact private custody supplies this keyed user's approved storage bytes.
    : options.prepareMessageAfterIdempotencyCheck
      ? options.prepareMessageAfterIdempotencyCheck(options.message)
      : options.message;
  if (prepared === undefined) {
    return undefined;
  }

  const messageId =
    pending && !pending.alreadyPromoted ? pending.inputId : (options.eventId ?? randomUUID());
  const now = options.now ?? Date.now();
  const finalMessage = pending ? prepared : serializeForStorage(prepared);
  ensureTranscriptHeader(database, resolved, options.cwd);
  const parentId = resolveTranscriptMessageAppendParent(database, resolved.sessionId, options);
  const event = {
    type: "message",
    id: messageId,
    parentId: parentId ?? null,
    timestamp: resolveTimestampMsToIsoString(now),
    message: finalMessage,
  };
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    idempotencyKeyMode:
      options.idempotencyLookup === "caller-checked"
        ? "relocate-owner"
        : options.idempotencyLookup === "scan-assistant"
          ? "preserve-owner"
          : "dedupe",
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
  // SAFETY: Receipt custody comes from this event's exact committed JSON after storage normalization.
  const persistedMessage = (JSON.parse(appended) as typeof event).message;
  const anchor = readAnchor({ message: persistedMessage, messageId });
  if (pending) {
    if (pending.commitRelocation) {
      if (
        !deferOpenClawAgentPostCommitPublication(database, () =>
          pending.commitRelocation?.(messageId),
        )
      ) {
        throw new Error("Pending input relocation requires a transcript write transaction");
      }
    } else {
      consumeSessionPendingInput(database, pending);
    }
  }
  return {
    appended: true,
    ...(anchor ? { anchor } : {}),
    effectiveParentId: parentId ?? null,
    message: persistedMessage,
    messageId,
  };
}
