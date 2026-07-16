import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { SqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import {
  serializeJsonlLine,
  writeJsonlEntriesSync,
} from "../../config/sessions/transcript-jsonl.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  hasReadableSessionHeader,
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import {
  loadEntriesFromFileWithSnapshot,
  loadSqliteMarkedSessionFile,
  publishRememberedSessionFileSnapshot,
  recoverCorruptSessionEntries,
  rememberWrittenSessionEntries,
  type LoadedSessionFile,
} from "./session-manager-file.js";
import { createSessionId, generateSessionEntryId } from "./session-manager-id.js";
import type {
  FileEntry,
  NewSessionOptions,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionFileSnapshot,
  SessionHeader,
  SessionLeafControl,
} from "./session-manager-types.js";

export type SqliteSessionManagerPersistence = SqliteSessionFileMarker & {
  sessionKey: string;
};

export class SessionManagerCore {
  protected sessionId = "";
  protected sessionFile: string | undefined;
  protected sessionDir: string;
  protected cwd: string;
  protected shouldPersist: boolean;
  protected flushed = false;
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
  protected promptReleasedSideBranchParentId: string | null | undefined;
  protected recoveredCorruptHeader = false;
  protected sessionFileSnapshot: SessionFileSnapshot | undefined;
  protected sqlitePersistence: SqliteSessionManagerPersistence | undefined;

  constructor(
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean,
    loadedSessionFile?: LoadedSessionFile,
    sqlitePersistence?: SqliteSessionManagerPersistence,
  ) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.shouldPersist = persist;
    this.sqlitePersistence = sqlitePersistence;
    if (persist && sessionDir && !existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    if (sessionFile) {
      if (sqlitePersistence) {
        this.setLoadedSqliteSessionFile(
          sessionFile,
          loadedSessionFile ?? { entries: [], snapshot: undefined },
        );
      } else {
        this.setLoadedSessionFile(
          sessionFile,
          loadedSessionFile ?? loadEntriesFromFileWithSnapshot(sessionFile),
        );
      }
    } else {
      this.newSession();
    }
  }

  setSessionFile(sessionFile: string): void {
    const sqliteLoaded = loadSqliteMarkedSessionFile(
      sessionFile,
      (marker) => loadTranscriptEventsSync(marker) as FileEntry[],
      { fallbackCwd: this.cwd },
    );
    if (sqliteLoaded) {
      this.cwd = sqliteLoaded.cwd;
      this.sqlitePersistence = {
        ...sqliteLoaded.sqliteMarker,
        sessionKey: sqliteLoaded.sessionKey,
      };
      this.setLoadedSqliteSessionFile(sessionFile, {
        entries: sqliteLoaded.entries,
        snapshot: undefined,
      });
      return;
    }
    this.sqlitePersistence = undefined;
    this.setLoadedSessionFile(sessionFile, loadEntriesFromFileWithSnapshot(sessionFile));
  }

  protected setLoadedSessionFile(sessionFile: string, loaded: LoadedSessionFile): void {
    this.sessionFile = resolve(sessionFile);
    this.sessionFileSnapshot = undefined;
    this.recoveredCorruptHeader = false;
    if (!existsSync(this.sessionFile)) {
      const explicitPath = this.sessionFile;
      this.newSession();
      this.sessionFile = explicitPath;
      return;
    }

    const partitioned = partitionSessionFileEntries(loaded.entries);
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    this.sessionFileSnapshot = loaded.snapshot;
    if (this.fileEntries.length === 0) {
      const recoveredEntries = recoverCorruptSessionEntries(this.sessionFile, this.cwd);
      if (recoveredEntries && hasReadableSessionHeader(recoveredEntries)) {
        const recovered = partitionSessionFileEntries(recoveredEntries);
        this.fileEntries = recovered.fileEntries;
        this.opaqueFileEntries = recovered.opaqueEntries;
        const header = this.fileEntries.find((entry) => entry.type === "session");
        this.sessionId = header?.id ?? createSessionId();
        migrateToCurrentVersion(this.fileEntries, recovered.fileEntriesByOriginalIndex);
        this.buildIndex();
        this.replacePersistedTranscript();
        this.recoveredCorruptHeader = true;
        this.flushed = true;
        return;
      }

      const explicitPath = this.sessionFile;
      this.newSession();
      this.sessionFile = explicitPath;
      this.replacePersistedTranscript();
      this.flushed = true;
      return;
    }

    const header = this.fileEntries.find((entry) => entry.type === "session");
    this.sessionId = header?.id ?? createSessionId();
    const migrated = migrateToCurrentVersion(
      this.fileEntries,
      partitioned.fileEntriesByOriginalIndex,
    );
    this.buildIndex();
    if (migrated) {
      this.replacePersistedTranscript();
    }
    this.flushed = true;
  }

  protected setLoadedSqliteSessionFile(sessionFile: string, loaded: LoadedSessionFile): void {
    this.sessionFile = sessionFile;
    this.sessionFileSnapshot = undefined;
    this.recoveredCorruptHeader = false;
    const partitioned = partitionSessionFileEntries(loaded.entries);
    if (partitioned.fileEntries.length === 0) {
      this.newSession({ id: this.sqlitePersistence?.sessionId });
      this.sessionFile = sessionFile;
      return;
    }
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    const header = this.fileEntries.find((entry) => entry.type === "session");
    this.sessionId = header?.id ?? this.sqlitePersistence?.sessionId ?? createSessionId();
    migrateToCurrentVersion(this.fileEntries, partitioned.fileEntriesByOriginalIndex);
    this.buildIndex();
    this.flushed = true;
  }

  newSession(options?: NewSessionOptions): string | undefined {
    this.recoveredCorruptHeader = false;
    this.sessionFileSnapshot = undefined;
    this.sessionId = options?.id ?? createSessionId();
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
    this.promptReleasedSideBranchParentId = undefined;
    this.flushed = false;

    if (this.shouldPersist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
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
          this.opaqueParentsById.set(leafEntry.id, leafState.leafId);
          this.leafId = leafState.leafId;
          this.appendParentId = leafState.appendParentId;
          this.promptReleasedSideBranchParentId =
            leafState.appendMode === "side" ? leafState.appendParentId : undefined;
          opaqueIndex += 1;
          continue;
        }
        const link = parseParentLinkedOpaqueEntry(opaqueRecord);
        if (link) {
          this.opaqueParentsById.set(link.id, link.parentId);
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
      if (
        !Object.hasOwn(entry, "parentId") ||
        (!isSessionTranscriptSideAppendEntry(entry) &&
          entry.parentId === this.appendParentId &&
          this.leafId !== this.appendParentId)
      ) {
        this.logicalParentsById.set(entry.id, this.leafId);
      }
      this.byId.set(entry.id, entry);
      this.appendParentId = entry.id;
      if (isSessionTranscriptSideAppendEntry(entry)) {
        this.promptReleasedSideBranchParentId = entry.id;
      } else {
        this.leafId = entry.id;
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
    if (
      normalized.type === "compaction" &&
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
    this.opaqueParentsById.set(leafEntry.id, this.leafId);
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

  getSerializedFileLinesForRewrite(): string[] {
    return this.getPersistedFileEntries().map(serializeJsonlLine);
  }

  clearPreservedOpaqueFileEntries(): void {
    this.opaqueFileEntries = [];
    this.opaqueParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.appendParentId = null;
    this.promptReleasedSideBranchParentId = undefined;
  }

  protected writeFullFile(
    leafAppendParentId: string | null = this.appendParentId,
    leafAppendMode?: "side",
  ): string {
    return this.sessionFile
      ? writeJsonlEntriesSync(
          this.sessionFile,
          this.getPersistedFileEntries(leafAppendParentId, leafAppendMode),
        )
      : "";
  }

  protected replacePersistedTranscript(options?: {
    publishSnapshot?: boolean;
    leafAppendParentId?: string | null;
    leafAppendMode?: "side";
  }): void {
    if (!this.shouldPersist) {
      return;
    }
    const leafAppendParentId =
      options?.leafAppendParentId === undefined ? this.appendParentId : options.leafAppendParentId;
    if (this.sqlitePersistence) {
      replaceTranscriptEventsSync(
        {
          agentId: this.sqlitePersistence.agentId,
          sessionId: this.sqlitePersistence.sessionId,
          sessionKey: this.sqlitePersistence.sessionKey,
          storePath: this.sqlitePersistence.storePath,
        },
        this.getPersistedFileEntries(leafAppendParentId, options?.leafAppendMode),
      );
      this.flushed = true;
      return;
    }
    if (!this.sessionFile) {
      return;
    }
    const content = this.writeFullFile(leafAppendParentId, options?.leafAppendMode);
    const rememberedWrite = rememberWrittenSessionEntries(this.sessionFile, content);
    this.sessionFileSnapshot = rememberedWrite.snapshot;
    if (rememberedWrite.verifiedWrite && options?.publishSnapshot !== false) {
      publishRememberedSessionFileSnapshot(this.sessionFile, rememberedWrite.snapshot);
    }
  }

  isPersisted(): boolean {
    return this.shouldPersist;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  wasRecoveredFromCorruptHeader(): boolean {
    return this.recoveredCorruptHeader;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }
}
