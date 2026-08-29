import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import type { AppendPersistenceOptions, SessionEntry } from "./session-manager-types.js";

type PersistRecordResult =
  | string
  | null
  | undefined
  | {
      anchor?: TranscriptEntryAnchor;
      adoptedMessageId?: string;
      effectiveParentId: string | null;
    };

function requireTranscriptEventAppend(
  result: ReturnType<typeof appendTranscriptEventSync>,
  message: string,
): void {
  if (result.ok && result.value) {
    return;
  }
  const cause = result.ok ? { code: "transcript-event-not-appended" as const } : result.error;
  throw new Error(`${message}: ${cause.code}`, { cause });
}

export class SessionManagerPersistence extends SessionManagerCore {
  removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
    this.ensureCompletePersistedHistory();
    let preservedStart = this.fileEntries.length;
    while (preservedStart > 1) {
      const entry = this.fileEntries[preservedStart - 1];
      if (!isIndexedSessionEntry(entry) || !options?.preserveTrailing?.(entry)) {
        break;
      }
      preservedStart -= 1;
    }

    let removeStart = preservedStart;
    while (removeStart > 1) {
      const entry = this.fileEntries[removeStart - 1];
      if (!isIndexedSessionEntry(entry) || !predicate(entry)) {
        break;
      }
      removeStart -= 1;
    }
    if (removeStart === preservedStart) {
      return 0;
    }

    const shiftOpaqueIndexesAfterRemoval = (start: number, count: number): void => {
      for (const opaqueEntry of this.opaqueFileEntries) {
        const removedBeforeOpaque = Math.max(0, Math.min(count, opaqueEntry.index - start));
        opaqueEntry.index -= removedBeforeOpaque;
      }
    };
    const removedCount = preservedStart - removeStart;
    shiftOpaqueIndexesAfterRemoval(removeStart, removedCount);
    const removedEntries = this.fileEntries.splice(removeStart, removedCount) as SessionEntry[];
    const removedParentById = new Map(
      removedEntries.map((entry) => [entry.id, entry.parentId] as const),
    );
    for (let index = removeStart; index < this.fileEntries.length;) {
      const entry = this.fileEntries[index];
      if (
        isIndexedSessionEntry(entry) &&
        entry.type === "label" &&
        removedParentById.has(entry.targetId)
      ) {
        removedParentById.set(entry.id, entry.parentId);
        shiftOpaqueIndexesAfterRemoval(index, 1);
        this.fileEntries.splice(index, 1);
        continue;
      }
      index += 1;
    }

    const resolveRetainedParentId = (parentId: string | null): string | null => {
      const seen = new Set<string>();
      let currentId = parentId;
      while (currentId && removedParentById.has(currentId) && !seen.has(currentId)) {
        seen.add(currentId);
        currentId = removedParentById.get(currentId) ?? null;
      }
      return currentId;
    };
    const replacementParentId = resolveRetainedParentId(removedEntries[0]?.parentId ?? null);
    this.fileEntries = this.fileEntries.map((entry) => {
      if (!isIndexedSessionEntry(entry)) {
        return entry;
      }
      const parentId = resolveRetainedParentId(entry.parentId);
      return parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry);
    });
    this.opaqueFileEntries = this.opaqueFileEntries.map((opaqueEntry) => {
      if (!isRecord(opaqueEntry.record)) {
        return opaqueEntry;
      }
      const record = opaqueEntry.record;
      const parentId =
        record.parentId === null || typeof record.parentId === "string"
          ? resolveRetainedParentId(record.parentId)
          : undefined;
      const leafEntry = parseOpaqueLeafEntry(record);
      const targetId = leafEntry ? resolveRetainedParentId(leafEntry.targetId) : undefined;
      const appendParentId =
        leafEntry?.appendParentId !== undefined
          ? resolveRetainedParentId(leafEntry.appendParentId)
          : undefined;
      if (
        (parentId === undefined || parentId === record.parentId) &&
        (targetId === undefined || targetId === leafEntry?.targetId) &&
        (appendParentId === undefined || appendParentId === leafEntry?.appendParentId)
      ) {
        return opaqueEntry;
      }
      return {
        ...opaqueEntry,
        record: {
          ...record,
          ...(parentId !== undefined ? { parentId } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
          ...(appendParentId !== undefined ? { appendParentId } : {}),
        },
      };
    });

    this.clampOpaqueFileEntryIndexes();
    this.buildIndex();
    this.leafId = this.resolveCanonicalParentId(replacementParentId);
    this.appendParentId = replacementParentId;
    this.replacePersistedTranscript();
    return removedEntries.length;
  }

  protected persistRecord(entry: unknown, options?: AppendPersistenceOptions): PersistRecordResult {
    if (this.persistenceTarget) {
      return this.persistSqliteRecord(entry, options);
    }
    return undefined;
  }

  persist(entry: SessionEntry, options?: AppendPersistenceOptions): PersistRecordResult {
    return this.persistRecord(entry, options);
  }

  private persistSqliteRecord(
    entry: unknown,
    options?: AppendPersistenceOptions,
  ): PersistRecordResult {
    if (!this.persistenceTarget) {
      return undefined;
    }
    const scope = this.persistenceTarget;
    if (this.persistenceHeaderPending) {
      if (
        !ensureSessionEntrySync(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
        })
      ) {
        throw new Error("Session transcript header was not persisted");
      }
      const header = this.fileEntries[0];
      if (!header || header.type !== "session") {
        throw new Error("Session transcript header was not persisted");
      }
      requireTranscriptEventAppend(
        appendTranscriptEventSync(scope, header),
        "Session transcript header was not persisted",
      );
      this.persistenceHeaderPending = false;
    }
    const leafEntry = parseOpaqueLeafEntry(entry);
    if (leafEntry) {
      requireTranscriptEventAppend(
        appendTranscriptEventSync(scope, entry),
        `Session transcript leaf control was not persisted: ${leafEntry.id}`,
      );
      return undefined;
    }
    if (!isIndexedSessionEntry(entry)) {
      return undefined;
    }
    if (entry.type !== "message") {
      requireTranscriptEventAppend(
        appendTranscriptEventSync(
          scope,
          entry,
          options?.appendIntent === "active-branch"
            ? { appendIntent: options.appendIntent }
            : undefined,
        ),
        `Session transcript entry was not persisted: ${entry.id}`,
      );
      return undefined;
    }
    const appendOptions = copyCodeModeSourceAppendOptions(options, {
      cwd: this.cwd,
      eventId: entry.id,
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      message: entry.message,
      now: Date.parse(entry.timestamp),
      parentId: entry.parentId,
      ...(options?.appendIntent === "active-branch" ? { appendIntent: options.appendIntent } : {}),
    } satisfies Parameters<typeof appendTranscriptMessageSync>[1]);
    const outcome = appendTranscriptMessageSync(scope, appendOptions);
    if (!outcome.ok) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`, {
        cause: outcome.error,
      });
    }
    const result = outcome.value;
    if (!result) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`);
    }
    if (result.messageId !== entry.id) {
      const idempotencyKey =
        entry.message.role === "user" &&
        "idempotencyKey" in entry.message &&
        typeof entry.message.idempotencyKey === "string" &&
        entry.message.idempotencyKey.length > 0
          ? entry.message.idempotencyKey
          : undefined;
      if (idempotencyKey && options?.idempotencyLookup !== "caller-checked") {
        // Ingress can commit the keyed user after this manager loaded. The
        // caller reloads and adopts only when that canonical row is still active.
        if (!result.anchor) {
          throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
        }
        return {
          adoptedMessageId: result.messageId,
          anchor: result.anchor,
          effectiveParentId: result.effectiveParentId ?? null,
        };
      }
      throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
    }
    if (
      options?.idempotencyLookup === "caller-checked" &&
      (!result?.appended || result.messageId !== entry.id)
    ) {
      throw new Error(`Session transcript append was not persisted: ${entry.id}`);
    }
    if (result.effectiveParentId === undefined) {
      throw new Error(`Session transcript append parent was not returned: ${entry.id}`);
    }
    // appendEntry owns this JSON copy. Cache the final storage projection: a
    // second credential mask can differ from the guard's diagnostic hint.
    entry.message = result.message;
    return {
      ...(result.anchor ? { anchor: result.anchor } : {}),
      effectiveParentId: result.effectiveParentId,
    };
  }
}
