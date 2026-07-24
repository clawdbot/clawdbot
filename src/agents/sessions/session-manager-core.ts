import {
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import { createSessionId, generateSessionEntryId } from "./session-manager-id.js";
import type {
  FileEntry,
  NewSessionOptions,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
  SessionLeafControl,
} from "./session-manager-types.js";

export type SessionManagerPersistenceTarget = SessionTranscriptRuntimeTarget;

export class SessionManagerCore {
  migrated = false;
  protected sessionId = "";
  protected cwd: string;
  protected fileEntries: FileEntry[] = [];
  protected opaqueFileEntries: PreservedOpaqueFileEntry[] = [];
  protected byId: Map<string, SessionEntry> = new Map();
  protected opaqueParentsById: Map<string, string | null> = new Map();
  protected logicalParentsById: Map<string, string | null> = new Map();
  protected invalidLeafControlIds: Set<string> = new Set();
  protected labelsById: Map<string, string> = new Map();
  protected labelTimestampsById: Map<string, string> = new Map();
  protected leafId: string | null = null;
  protected appendParentId: string | null = null;
  protected appendMode: "side" | undefined;
  protected promptReleasedSideBranchParentId: string | null | undefined;
  protected persistenceTarget: SessionManagerPersistenceTarget | undefined;

  constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: FileEntry[],
  ) {
    this.cwd = cwd;
    this.persistenceTarget = persistenceTarget;
    if (persistenceTarget || loadedEntries) {
      this.setLoadedSessionTarget(persistenceTarget, loadedEntries ?? []);
    } else {
      this.newSession();
    }
  }

  setSessionTarget(target: SessionManagerPersistenceTarget): void {
    const entries = loadTranscriptEventsSync(target) as FileEntry[];
    const header = entries.find((entry) => entry.type === "session");
    if (header?.cwd) {
      this.cwd = header.cwd;
    }
    this.setLoadedSessionTarget(target, entries);
  }

  protected setLoadedSessionTarget(
    target: SessionManagerPersistenceTarget | undefined,
    entries: FileEntry[],
  ): void {
    this.persistenceTarget = target;
    const partitioned = partitionSessionFileEntries(entries);
    if (partitioned.fileEntries.length === 0) {
      this.initializeSession({ id: target?.sessionId });
      return;
    }
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    const header = this.fileEntries.find((entry) => entry.type === "session");
    this.sessionId = header?.id ?? target?.sessionId ?? createSessionId();
    this.migrated = migrateToCurrentVersion(
      this.fileEntries,
      partitioned.fileEntriesByOriginalIndex,
    );
    this.buildIndex();
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.persistenceTarget) {
      throw new Error("Persisted session managers cannot change session identity in place");
    }
    return this.initializeSession(options);
  }

  private initializeSession(options?: NewSessionOptions): string | undefined {
    this.sessionId = options?.id ?? this.persistenceTarget?.sessionId ?? createSessionId();
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
    this.logicalParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.promptReleasedSideBranchParentId = undefined;
    return this.persistenceTarget ? this.sessionId : undefined;
  }

  protected resolveOpaqueLeafTargetId(targetId: string | null): string | null {
    if (targetId === null || this.byId.has(targetId)) {
      return targetId;
    }
    return this.resolveCanonicalParentId(targetId);
  }

  protected resolveOpaqueAppendParentId(parentId: string | null): string | null {
    if (parentId === null || this.byId.has(parentId) || this.opaqueParentsById.has(parentId)) {
      return parentId;
    }
    return this.resolveCanonicalParentId(parentId);
  }

  protected resolveOpaqueLeafControl(
    leafEntry: ReturnType<typeof parseOpaqueLeafEntry>,
  ): { leafId: string | null; appendParentId: string | null; appendMode?: "side" } | undefined {
    if (!leafEntry) {
      return undefined;
    }
    const isKnownReference = (id: string | null): boolean =>
      id === null ||
      this.byId.has(id) ||
      (this.opaqueParentsById.has(id) && !this.invalidLeafControlIds.has(id));
    if (
      !isKnownReference(leafEntry.targetId) ||
      (leafEntry.appendParentId !== undefined && !isKnownReference(leafEntry.appendParentId))
    ) {
      return undefined;
    }
    const leafId = this.resolveOpaqueLeafTargetId(leafEntry.targetId);
    return {
      leafId,
      appendParentId:
        leafEntry.appendParentId === undefined
          ? leafId
          : this.resolveOpaqueAppendParentId(leafEntry.appendParentId),
      ...(leafEntry.appendMode ? { appendMode: leafEntry.appendMode } : {}),
    };
  }

  protected buildIndex(): void {
    this.byId.clear();
    this.opaqueParentsById.clear();
    this.logicalParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.appendParentId = null;
    this.promptReleasedSideBranchParentId = undefined;
    let opaqueIndex = 0;
    let latestResetId: string | undefined;
    const resetDescendantIds = new Set<string>();
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        const opaqueRecord = this.opaqueFileEntries[opaqueIndex]?.record;
        const leafEntry = parseOpaqueLeafEntry(opaqueRecord);
        if (leafEntry) {
          const leafState = this.resolveOpaqueLeafControl(leafEntry);
          if (!leafState) {
            this.invalidLeafControlIds.add(leafEntry.id);
            this.opaqueParentsById.set(
              leafEntry.id,
              this.resolveOpaqueAppendParentId(leafEntry.parentId),
            );
            opaqueIndex += 1;
            continue;
          }
          const crossesResetBoundary =
            latestResetId !== undefined &&
            (leafState.leafId === null || !resetDescendantIds.has(leafState.leafId));
          const effectiveLeafState: typeof leafState = crossesResetBoundary
            ? { leafId: this.leafId, appendParentId: this.leafId }
            : leafState;
          this.opaqueParentsById.set(leafEntry.id, effectiveLeafState.leafId);
          if (
            latestResetId !== undefined &&
            effectiveLeafState.leafId !== null &&
            resetDescendantIds.has(effectiveLeafState.leafId)
          ) {
            resetDescendantIds.add(leafEntry.id);
          }
          this.leafId = effectiveLeafState.leafId;
          this.appendParentId = effectiveLeafState.appendParentId;
          this.appendMode = effectiveLeafState.appendMode;
          this.promptReleasedSideBranchParentId =
            effectiveLeafState.appendMode === "side"
              ? effectiveLeafState.appendParentId
              : undefined;
          opaqueIndex += 1;
          continue;
        }
        const link = parseParentLinkedOpaqueEntry(opaqueRecord);
        if (link) {
          this.opaqueParentsById.set(link.id, link.parentId);
          if (
            latestResetId !== undefined &&
            link.parentId !== null &&
            resetDescendantIds.has(link.parentId)
          ) {
            resetDescendantIds.add(link.id);
          }
          this.appendParentId = link.id;
          if (this.promptReleasedSideBranchParentId !== undefined) {
            this.promptReleasedSideBranchParentId = link.id;
          }
        }
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      if (!isIndexedSessionEntry(entry)) {
        continue;
      }
      if (entry.type === "label" && !this.byId.has(entry.targetId)) {
        this.opaqueParentsById.set(entry.id, this.resolveCanonicalParentId(entry.parentId));
        continue;
      }
      const crossesResetBoundary =
        latestResetId !== undefined &&
        !isSessionTranscriptSideAppendEntry(entry) &&
        (entry.parentId === null || !resetDescendantIds.has(entry.parentId));
      if (
        crossesResetBoundary ||
        !Object.hasOwn(entry, "parentId") ||
        (!isSessionTranscriptSideAppendEntry(entry) &&
          entry.parentId === this.appendParentId &&
          this.leafId !== this.appendParentId)
      ) {
        this.logicalParentsById.set(entry.id, this.leafId);
      }
      this.byId.set(entry.id, entry);
      if (entry.type === "reset") {
        latestResetId = entry.id;
        resetDescendantIds.clear();
        resetDescendantIds.add(entry.id);
      } else {
        const logicalParentId = this.logicalParentsById.has(entry.id)
          ? (this.logicalParentsById.get(entry.id) ?? null)
          : entry.parentId;
        if (
          latestResetId !== undefined &&
          logicalParentId !== null &&
          resetDescendantIds.has(logicalParentId)
        ) {
          resetDescendantIds.add(entry.id);
        }
      }
      this.appendParentId = entry.id;
      if (isSessionTranscriptSideAppendEntry(entry)) {
        this.appendMode = "side";
        this.promptReleasedSideBranchParentId = entry.id;
      } else {
        this.leafId = entry.id;
        this.appendMode = undefined;
        this.promptReleasedSideBranchParentId = undefined;
      }
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
  }

  protected resolveCanonicalParentId(parentId: string | null): string | null {
    const seen = new Set<string>();
    let currentId = parentId;
    while (currentId && !this.byId.has(currentId)) {
      if (seen.has(currentId)) {
        return null;
      }
      seen.add(currentId);
      currentId = this.opaqueParentsById.get(currentId) ?? null;
    }
    return currentId;
  }

  protected normalizeEntryParent(entry: SessionEntry): SessionEntry {
    const parentId = this.logicalParentsById.has(entry.id)
      ? (this.logicalParentsById.get(entry.id) ?? null)
      : this.resolveCanonicalParentId(entry.parentId);
    let normalized = parentId === entry.parentId ? entry : { ...entry, parentId };
    if (normalized.parentId === normalized.id) {
      normalized = { ...normalized, parentId: null };
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
        parentId;
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
      id: generateSessionEntryId({
        has: (id) => this.byId.has(id) || this.opaqueParentsById.has(id),
      }),
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
    this.promptReleasedSideBranchParentId = undefined;
  }

  protected replacePersistedTranscript(options?: {
    leafAppendParentId?: string | null;
    leafAppendMode?: "side";
  }): void {
    if (!this.persistenceTarget) {
      return;
    }
    const leafAppendParentId =
      options?.leafAppendParentId === undefined ? this.appendParentId : options.leafAppendParentId;
    replaceTranscriptEventsSync(
      this.persistenceTarget,
      this.getPersistedFileEntries(leafAppendParentId, options?.leafAppendMode ?? this.appendMode),
    );
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
    return this.persistenceTarget;
  }
}
