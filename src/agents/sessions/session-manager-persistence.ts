import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
} from "../../config/sessions/session-accessor.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import {
  isIndexedSessionEntry,
  isJsonRecord,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import type {
  AppendPersistenceOptions,
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
  SessionEntry,
} from "./session-manager-types.js";

export class SessionManagerPersistence extends SessionManagerCore {
  removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
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
      if (!isJsonRecord(opaqueEntry.record)) {
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

  protected persistRecord(entry: unknown, options?: AppendPersistenceOptions): void {
    if (this.persistenceTarget) {
      this.persistSqliteRecord(entry, options);
    }
  }

  persist(entry: SessionEntry, options?: AppendPersistenceOptions): void {
    this.persistRecord(entry, options);
  }

  private persistSqliteRecord(entry: unknown, options?: AppendPersistenceOptions): void {
    if (!isIndexedSessionEntry(entry) || !this.persistenceTarget) {
      return;
    }
    const scope = this.persistenceTarget;
    if (entry.type !== "message") {
      appendTranscriptEventSync(scope, entry);
      return;
    }
    const appendOptions = {
      cwd: this.cwd,
      eventId: entry.id,
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      message: entry.message,
      now: Date.parse(entry.timestamp),
      parentId: entry.parentId,
    } satisfies Parameters<typeof appendTranscriptMessageSync>[1];
    let result = appendTranscriptMessageSync(scope, appendOptions);
    if (result && !result.appended && result.messageId !== entry.id) {
      // SessionManager has already adopted this event ID as the next parent. A
      // pre-persisted user turn may share its idempotency key, but dropping the
      // canonical node would leave every later descendant dangling in SQLite.
      result = appendTranscriptMessageSync(scope, {
        ...appendOptions,
        idempotencyLookup: "caller-checked",
      });
    }
    if (result && result.messageId !== entry.id) {
      throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
    }
    if (
      options?.idempotencyLookup === "caller-checked" &&
      (!result?.appended || result.messageId !== entry.id)
    ) {
      throw new Error(`Session transcript append was not persisted: ${entry.id}`);
    }
  }

  mergePromptReleasedSessionEntries(
    entries: readonly PromptReleasedSessionEntry[],
    options?: { persistLeaf?: boolean },
  ): PromptReleasedSessionMergeResult | undefined {
    this.assertPromptReleasedEntriesPreserveActiveLeaf(entries);
    let sideBranchParentId =
      this.promptReleasedSideBranchParentId === undefined
        ? this.leafId
        : this.promptReleasedSideBranchParentId;
    let persistedLeafId = this.leafId;
    let persistedAppendParentId = this.appendParentId;
    let persistedAppendMode: "active" | "side" =
      this.promptReleasedSideBranchParentId === undefined ? "active" : "side";
    let sawPersistedStateUpdate = false;
    let rawTailId: string | null = null;

    for (const sourceEntry of entries) {
      if (sourceEntry.type === "prompt_released_opaque") {
        this.opaqueFileEntries.push({ index: this.fileEntries.length, record: sourceEntry.record });
        const leafEntry = parseOpaqueLeafEntry(sourceEntry.record);
        if (leafEntry) {
          rawTailId = leafEntry.id;
          const leafState = this.resolveOpaqueLeafControl(leafEntry);
          if (!leafState) {
            this.invalidLeafControlIds.add(leafEntry.id);
            this.opaqueParentsById.set(
              leafEntry.id,
              this.resolveOpaqueAppendParentId(leafEntry.parentId),
            );
            continue;
          }
          this.opaqueParentsById.set(leafEntry.id, leafState.leafId);
          sideBranchParentId = leafState.appendParentId;
          persistedLeafId = leafState.leafId;
          persistedAppendParentId = leafState.appendParentId;
          persistedAppendMode = leafState.appendMode === "side" ? "side" : "active";
          sawPersistedStateUpdate = true;
          continue;
        }
        const link = parseParentLinkedOpaqueEntry(sourceEntry.record);
        if (link) {
          this.opaqueParentsById.set(link.id, link.parentId);
          sideBranchParentId = link.id;
          persistedAppendParentId = link.id;
          sawPersistedStateUpdate = true;
          rawTailId = link.id;
        }
        continue;
      }

      if (this.byId.has(sourceEntry.id)) {
        throw new Error(`Entry ${sourceEntry.id} already exists`);
      }
      if (sourceEntry.type === "label" && !this.byId.has(sourceEntry.targetId)) {
        throw new Error(`Entry ${sourceEntry.targetId} not found`);
      }
      const entry: PromptReleasedSessionEntry = {
        ...sourceEntry,
        parentId: sideBranchParentId,
      };
      this.fileEntries.push(entry);
      this.byId.set(entry.id, entry);
      sideBranchParentId = entry.id;
      persistedAppendParentId = entry.id;
      if (isSessionTranscriptSideAppendEntry(entry)) {
        persistedAppendMode = "side";
      } else {
        persistedLeafId = entry.id;
        persistedAppendMode = "active";
      }
      sawPersistedStateUpdate = true;
      rawTailId = entry.id;
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
          this.labelTimestampsById.set(entry.targetId, entry.timestamp);
        } else {
          this.labelsById.delete(entry.targetId);
          this.labelTimestampsById.delete(entry.targetId);
        }
      }
    }
    this.promptReleasedSideBranchParentId = sideBranchParentId;
    if (
      options?.persistLeaf !== true ||
      !this.persistenceTarget ||
      !sawPersistedStateUpdate ||
      (persistedLeafId === this.leafId &&
        persistedAppendParentId === sideBranchParentId &&
        persistedAppendMode === "side")
    ) {
      return undefined;
    }

    const leafEntry = this.createLeafControl(rawTailId, sideBranchParentId, "side");
    appendTranscriptEventSync(this.persistenceTarget, leafEntry);
    this.rememberLeafControl(leafEntry);
    return { publishedEntries: [{ kind: "id", id: leafEntry.id }] };
  }

  private assertPromptReleasedEntriesPreserveActiveLeaf(
    entries: readonly PromptReleasedSessionEntry[],
  ): void {
    let sideBranchParentId =
      this.promptReleasedSideBranchParentId === undefined
        ? this.leafId
        : this.promptReleasedSideBranchParentId;
    for (const entry of entries) {
      if (entry.type !== "prompt_released_opaque") {
        sideBranchParentId = entry.id;
        continue;
      }
      const leaf = parseOpaqueLeafEntry(entry.record);
      if (leaf && entry.preserveActiveLeaf) {
        const appendParentId =
          leaf.appendParentId === undefined ? leaf.targetId : leaf.appendParentId;
        if (
          leaf.appendMode !== "side" ||
          leaf.targetId !== this.leafId ||
          leaf.parentId !== sideBranchParentId ||
          appendParentId !== sideBranchParentId
        ) {
          throw new Error("prompt-released side leaf changed the active branch");
        }
        continue;
      }
      const link = parseParentLinkedOpaqueEntry(entry.record);
      if (link) {
        sideBranchParentId = link.id;
      }
    }
  }
}
