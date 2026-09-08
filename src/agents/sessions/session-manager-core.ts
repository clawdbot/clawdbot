import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import {
  readSessionTranscriptBoundedActiveContextCore,
  type SessionTranscriptBoundedActiveContext,
} from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { assertCurrentSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import { SessionEntryNavigation } from "../../config/sessions/session-entry-navigation.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import { createManagedSessionId, generateSessionEntryId } from "./session-manager-id.js";
import type {
  FileEntry,
  NewSessionOptions,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
  SessionLeafControl,
} from "./session-manager-types.js";

export type SessionManagerPersistenceTarget = SessionTranscriptRuntimeTarget;
export type SessionManagerBoundedContextLimits = { maxBytes: number; maxEvents: number };
export type SessionManagerBoundedContext = Pick<
  SessionTranscriptBoundedActiveContext,
  | "activeLeafEntryId"
  | "version"
  | "opaqueParents"
  | "parents"
  | "firstKeptRanges"
  | "boundaryCount"
> & { limits: SessionManagerBoundedContextLimits };

export class SessionManagerCore extends SessionEntryNavigation<SessionEntry> {
  migrated = false;
  protected sessionId = "";
  protected transcriptVersion: SessionTranscriptContextVersion | undefined = {
    generation: null,
    rawSeq: null,
  };
  protected cwd: string;
  protected fileEntries: FileEntry[] = [];
  protected opaqueFileEntries: PreservedOpaqueFileEntry[] = [];
  protected boundedParentIds = new Map<string, string | null>();
  private boundedFirstKeptById = new Map<string, string>();
  protected pendingDeliberateAppend = false;
  protected persistenceTarget: SessionManagerPersistenceTarget | undefined;
  protected persistenceHeaderPending = false;
  protected boundedContextLimits: SessionManagerBoundedContextLimits | undefined;
  protected boundedContextIncomplete = false;
  protected persistedBoundaryCount: number | undefined;

  constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: FileEntry[],
    boundedContext?: SessionManagerBoundedContext,
    version?: SessionTranscriptContextVersion,
  ) {
    super();
    this.cwd = cwd;
    this.persistenceTarget = persistenceTarget;
    this.boundedContextLimits = boundedContext?.limits;
    this.boundedContextIncomplete = boundedContext !== undefined;
    this.persistedBoundaryCount = boundedContext?.boundaryCount;
    if (persistenceTarget || loadedEntries) {
      this.setLoadedSessionTarget(persistenceTarget, loadedEntries ?? [], boundedContext, version);
    } else {
      this.newSession();
    }
  }

  setSessionTarget(target: SessionManagerPersistenceTarget): void {
    const bounded = this.boundedContextLimits
      ? readSessionTranscriptBoundedActiveContextCore(target, this.boundedContextLimits)
      : undefined;
    const snapshot = bounded ?? loadTranscriptReadSnapshotSync(target);
    const entries = snapshot.events as FileEntry[];
    this.boundedContextIncomplete = bounded !== undefined;
    this.persistedBoundaryCount = bounded?.boundaryCount;
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    this.setLoadedSessionTarget(target, entries, bounded, snapshot.version);
    if (header?.cwd) {
      this.cwd = header.cwd;
    }
  }

  /** Active-only loads can omit sibling rows even when they fit the context limits. */
  protected ensureCompletePersistedHistory(): void {
    if (!this.persistenceTarget || !this.boundedContextIncomplete) {
      return;
    }
    const limits = this.boundedContextLimits;
    this.boundedContextLimits = undefined;
    this.setSessionTarget(this.persistenceTarget);
    this.boundedContextLimits = limits;
  }

  protected setLoadedSessionTarget(
    target: SessionManagerPersistenceTarget | undefined,
    entries: FileEntry[],
    bounded?: Pick<
      SessionTranscriptBoundedActiveContext,
      "activeLeafEntryId" | "version" | "opaqueParents" | "parents" | "firstKeptRanges"
    >,
    version?: SessionTranscriptContextVersion,
  ): void {
    this.transcriptVersion = version ?? bounded?.version;
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    const partitioned = partitionSessionFileEntries(entries);
    // Only a physically empty transcript may initialize lazily. Opaque persisted rows still need
    // a canonical header, or runtime would silently replace malformed history with a fresh session.
    if (partitioned.fileEntries.length === 0 && partitioned.opaqueEntries.length === 0) {
      this.persistenceTarget = target ? { ...target } : undefined;
      this.initializeSession({ id: target?.sessionId });
      this.persistenceHeaderPending = target !== undefined;
      return;
    }
    const header = partitioned.fileEntries.find((entry) => entry.type === "session");
    if (target) {
      assertCurrentSessionTranscriptHeader(header);
    }
    this.persistenceHeaderPending = false;
    this.persistenceTarget = target ? { ...target } : undefined;
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    this.sessionId = header?.id ?? target?.sessionId ?? createManagedSessionId();
    this.migrated = migrateToCurrentVersion(
      this.fileEntries,
      partitioned.fileEntriesByOriginalIndex,
    );
    this.buildIndex();
    if (bounded) {
      this.boundedParentIds = new Map(bounded.parents);
      for (const [id, parentId] of bounded.opaqueParents) {
        this.opaqueParentsById.set(id, parentId);
      }
      this.adoptSelectedTranscriptPath(bounded.activeLeafEntryId, bounded.parents);
      for (const [boundaryId, range] of bounded.firstKeptRanges) {
        // An empty retained slice starts at the boundary itself, never at an
        // earlier ancestor. Opaque entries do not become model-context cut points.
        let firstKeptEntryId = boundaryId;
        for (let index = range.startIndex; index < range.endIndex; index++) {
          const entry = partitioned.fileEntriesByOriginalIndex[index];
          if (isIndexedSessionEntry(entry)) {
            firstKeptEntryId = entry.id;
            break;
          }
        }
        this.boundedFirstKeptById.set(boundaryId, firstKeptEntryId);
      }
    }
  }

  protected adoptSelectedTranscriptPath(
    appendParentId: string | null,
    parents: Iterable<readonly [string, string | null]>,
  ): void {
    // Selected payloads omit navigation controls. Use their resolved ancestry,
    // not the side-append parent guesses made while indexing those payloads.
    this.logicalParentsById.clear();
    for (const [id, parentId] of parents) {
      this.logicalParentsById.set(id, this.resolveCanonicalParentId(parentId));
    }
    this.appendParentId = appendParentId;
    this.leafId = this.resolveOpaqueLeafTargetId(appendParentId);
    this.appendMode = undefined;
  }

  /** The loaded view only: bounded managers must never hydrate inactive history for a rewrite. */
  protected captureTranscriptView() {
    return {
      sessionId: this.sessionId,
      transcriptVersion: this.transcriptVersion,
      migrated: this.migrated,
      fileEntries: this.fileEntries,
      opaqueFileEntries: this.opaqueFileEntries,
      byId: this.byId,
      opaqueParentsById: this.opaqueParentsById,
      logicalParentsById: this.logicalParentsById,
      invalidLeafControlIds: this.invalidLeafControlIds,
      labelsById: this.labelsById,
      labelTimestampsById: this.labelTimestampsById,
      boundedFirstKeptById: this.boundedFirstKeptById,
      boundedParentIds: this.boundedParentIds,
      boundedContextIncomplete: this.boundedContextIncomplete,
      boundedContextLimits: this.boundedContextLimits,
      persistedBoundaryCount: this.persistedBoundaryCount,
      leafId: this.leafId,
      appendParentId: this.appendParentId,
      appendMode: this.appendMode,
      pendingDeliberateAppend: this.pendingDeliberateAppend,
    };
  }

  reloadPersistedTranscript(): void {
    if (this.persistenceTarget) {
      const runtimeCwd = this.cwd;
      this.setSessionTarget(this.persistenceTarget);
      this.cwd = runtimeCwd;
    }
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.persistenceTarget) {
      throw new Error("Persisted session managers cannot change session identity in place");
    }
    return this.initializeSession(options);
  }

  private initializeSession(options?: NewSessionOptions): string | undefined {
    this.sessionId = options?.id ?? this.persistenceTarget?.sessionId ?? createManagedSessionId();
    this.migrated = false;
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.opaqueFileEntries = [];
    this.byId.clear();
    this.opaqueParentsById.clear();
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    this.logicalParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = false;
    return this.persistenceTarget ? this.sessionId : undefined;
  }

  protected buildIndex(): void {
    this.clearNavigation();
    this.pendingDeliberateAppend = false;
    let opaqueIndex = 0;
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        this.appendOpaqueNavigationRecord(this.opaqueFileEntries[opaqueIndex]?.record);
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      // Current entries were validated by partition/append. Legacy imports retain readable rows
      // through migration, so only those need the final shape check before indexing.
      if (!entry || entry.type === "session" || (this.migrated && !isIndexedSessionEntry(entry))) {
        continue;
      }
      this.appendCanonicalNavigationEntry(entry);
    }
    this.finishNavigation();
  }

  protected override normalizeEntryParent(entry: SessionEntry): SessionEntry {
    let normalized = super.normalizeEntryParent(entry);
    const boundedFirstKept = this.boundedFirstKeptById.get(normalized.id);
    if (
      boundedFirstKept !== undefined &&
      (normalized.type === "compaction" || normalized.type === "reset")
    ) {
      normalized = { ...normalized, firstKeptEntryId: boundedFirstKept };
    }
    if (
      (normalized.type === "compaction" || normalized.type === "reset") &&
      normalized.firstKeptEntryId !== undefined &&
      !this.byId.has(normalized.firstKeptEntryId) &&
      this.opaqueParentsById.has(normalized.firstKeptEntryId)
    ) {
      const resolvedFirstKeptParent = this.resolveCanonicalParentId(normalized.firstKeptEntryId);
      const firstKeptEntryId =
        resolvedFirstKeptParent ??
        this.findFirstCanonicalDescendantOnBranch(
          normalized.firstKeptEntryId,
          normalized.parentId,
        ) ??
        this.findFirstCanonicalDescendant(normalized.firstKeptEntryId) ??
        this.resolveEntryParentId(entry);
      if (firstKeptEntryId && firstKeptEntryId !== normalized.firstKeptEntryId) {
        normalized = { ...normalized, firstKeptEntryId };
      }
    }
    return normalized;
  }

  private findFirstCanonicalDescendantOnBranch(
    opaqueId: string,
    leafId: string | null,
  ): string | undefined {
    const seen = new Set<string>();
    let currentId = leafId;
    let firstCanonicalDescendant: string | undefined;
    while (currentId && !seen.has(currentId)) {
      if (currentId === opaqueId) {
        return firstCanonicalDescendant;
      }
      seen.add(currentId);
      const entry = this.byId.get(currentId);
      if (entry) {
        firstCanonicalDescendant = entry.id;
        currentId = entry.parentId;
      } else {
        currentId = this.opaqueParentsById.get(currentId) ?? null;
      }
    }
    return undefined;
  }

  private findFirstCanonicalDescendant(opaqueId: string): string | undefined {
    for (const entry of this.fileEntries) {
      if (!isIndexedSessionEntry(entry)) {
        continue;
      }
      const seen = new Set<string>();
      let parentId = entry.parentId;
      while (parentId && this.opaqueParentsById.has(parentId) && !seen.has(parentId)) {
        if (parentId === opaqueId) {
          return entry.id;
        }
        seen.add(parentId);
        parentId = this.opaqueParentsById.get(parentId) ?? null;
      }
    }
    return undefined;
  }

  protected resolveBranchTargetId(branchFromId: string): string | null | undefined {
    if (this.byId.has(branchFromId)) {
      return branchFromId;
    }
    if (!this.opaqueParentsById.has(branchFromId)) {
      return undefined;
    }
    return this.resolveCanonicalParentId(branchFromId);
  }

  protected clampOpaqueFileEntryIndexes(): void {
    let previousOpaqueIndex = 0;
    for (const opaqueEntry of this.opaqueFileEntries) {
      opaqueEntry.index = Math.max(
        previousOpaqueIndex,
        Math.min(opaqueEntry.index, this.fileEntries.length),
      );
      previousOpaqueIndex = opaqueEntry.index;
    }
  }

  protected createLeafControl(
    parentId: string | null,
    appendParentId: string | null = this.appendParentId,
    appendMode?: "side",
  ): SessionLeafControl {
    return {
      type: "leaf",
      id: generateSessionEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      targetId: this.leafId,
      ...(appendParentId !== this.leafId ? { appendParentId } : {}),
      ...(appendMode ? { appendMode } : {}),
    };
  }

  protected rememberLeafControl(leafEntry: SessionLeafControl): void {
    this.opaqueFileEntries.push({ index: this.fileEntries.length, record: leafEntry });
    this.opaqueParentsById.set(leafEntry.id, leafEntry.targetId);
  }

  getAppendParentId(): string | null {
    return this.appendParentId;
  }

  getAppendMode(): "side" | undefined {
    return this.appendMode;
  }

  protected getPersistedFileEntries(
    leafAppendParentId: string | null = this.appendParentId,
    leafAppendMode?: "side",
  ): unknown[] {
    this.clampOpaqueFileEntryIndexes();
    const entries: unknown[] = [];
    let opaqueIndex = 0;
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        entries.push(this.opaqueFileEntries[opaqueIndex]?.record);
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      if (entry) {
        entries.push(entry);
      }
    }
    while (opaqueIndex < this.opaqueFileEntries.length) {
      entries.push(this.opaqueFileEntries[opaqueIndex]?.record);
      opaqueIndex += 1;
    }

    let persistedLeafId: string | null = null;
    let persistedAppendParentId: string | null = null;
    let rawTailId: string | null = null;
    for (const entry of entries) {
      const leafEntry = parseOpaqueLeafEntry(entry);
      if (leafEntry) {
        rawTailId = leafEntry.id;
        if (this.invalidLeafControlIds.has(leafEntry.id)) {
          continue;
        }
        const targetId = this.resolveOpaqueLeafTargetId(leafEntry.targetId);
        persistedLeafId = targetId;
        persistedAppendParentId =
          leafEntry.appendParentId === undefined
            ? targetId
            : this.resolveOpaqueAppendParentId(leafEntry.appendParentId);
        continue;
      }
      if (isIndexedSessionEntry(entry)) {
        persistedLeafId = entry.id;
        persistedAppendParentId = entry.id;
        rawTailId = entry.id;
        continue;
      }
      const opaqueLink = parseParentLinkedOpaqueEntry(entry);
      if (opaqueLink) {
        persistedAppendParentId = opaqueLink.id;
        rawTailId = opaqueLink.id;
      }
    }
    if (persistedLeafId !== this.leafId || persistedAppendParentId !== this.appendParentId) {
      const leafEntry = this.createLeafControl(rawTailId, leafAppendParentId, leafAppendMode);
      this.rememberLeafControl(leafEntry);
      entries.push(leafEntry);
    }
    return entries;
  }

  getPersistedEntries(): unknown[] {
    return this.getPersistedFileEntries();
  }

  clearPreservedOpaqueFileEntries(): void {
    this.opaqueFileEntries = [];
    this.opaqueParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = false;
  }

  /** SQLite appends are synchronous; retained for the AgentSession contract. */
  protected flushPendingPersistence(): void {}

  isPersisted(): boolean {
    return this.persistenceTarget !== undefined;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionTarget(): SessionManagerPersistenceTarget | undefined {
    return this.persistenceTarget ? { ...this.persistenceTarget } : undefined;
  }
}
