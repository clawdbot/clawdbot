/**
 * Session tree manager backed by SQLite markers or explicit standalone files.
 *
 * The public facade lives here; codec, storage, persistence, and branching
 * behavior are split into focused internal modules.
 */
import { resolve } from "node:path";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ImageContent, Message, TextContent } from "../../llm/types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionManagerBranching } from "./session-manager-branching.js";
import type { SqliteSessionManagerPersistence } from "./session-manager-core.js";
import {
  getDefaultSessionDir,
  loadEntriesFromFileWithSnapshot,
  loadSqliteMarkedSessionFile,
  revalidateLoadedSessionFile,
  type LoadedSessionFile,
} from "./session-manager-file.js";
import type {
  AppendPersistenceOptions,
  FileEntry,
  NewSessionOptions,
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from "./session-manager-types.js";

export { CURRENT_SESSION_VERSION };
export {
  buildSessionContext,
  getLatestCompactionEntry,
  migrateSessionEntries,
  normalizeLoadedFileEntry,
  parseSessionEntries,
} from "./session-manager-codec.js";
export { getDefaultSessionDir, loadEntriesFromFile } from "./session-manager-file.js";
export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  FileEntry,
  LabelEntry,
  ModelChangeEntry,
  NewSessionOptions,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
} from "./session-manager-types.js";

export class SessionManager extends SessionManagerBranching {
  private constructor(
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean,
    loadedSessionFile?: LoadedSessionFile,
    sqlitePersistence?: SqliteSessionManagerPersistence,
  ) {
    super(cwd, sessionDir, sessionFile, persist, loadedSessionFile, sqlitePersistence);
  }

  override setSessionFile(sessionFile: string): void {
    super.setSessionFile(sessionFile);
  }

  override newSession(options?: NewSessionOptions): string | undefined {
    return super.newSession(options);
  }

  override getSerializedFileLinesForRewrite(): string[] {
    return super.getSerializedFileLinesForRewrite();
  }

  override clearPreservedOpaqueFileEntries(): void {
    super.clearPreservedOpaqueFileEntries();
  }

  /** Makes pending append-oriented persistence durable without rewriting committed entries. */
  override flushPendingPersistence(): void {
    super.flushPendingPersistence();
  }

  override isPersisted(): boolean {
    return super.isPersisted();
  }

  override getCwd(): string {
    return super.getCwd();
  }

  override getSessionDir(): string {
    return super.getSessionDir();
  }

  override getSessionId(): string {
    return super.getSessionId();
  }

  override wasRecoveredFromCorruptHeader(): boolean {
    return super.wasRecoveredFromCorruptHeader();
  }

  override getSessionFile(): string | undefined {
    return super.getSessionFile();
  }

  override removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
    return super.removeTrailingEntries(predicate, options);
  }

  override persist(entry: SessionEntry, options?: AppendPersistenceOptions): void {
    super.persist(entry, options);
  }

  override syncSnapshotAfterHeaderRewrite(expectedContent?: string): void {
    super.syncSnapshotAfterHeaderRewrite(expectedContent);
  }

  override mergePromptReleasedSessionEntries(
    entries: readonly PromptReleasedSessionEntry[],
    options?: { persistLeaf?: boolean },
  ): PromptReleasedSessionMergeResult | undefined {
    return super.mergePromptReleasedSessionEntries(entries, options);
  }

  override appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    return super.appendMessage(message, options);
  }

  override appendThinkingLevelChange(thinkingLevel: string): string {
    return super.appendThinkingLevelChange(thinkingLevel);
  }

  override appendModelChange(provider: string, modelId: string): string {
    return super.appendModelChange(provider, modelId);
  }

  override appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    return super.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook);
  }

  override appendCustomEntry(customType: string, data?: unknown): string {
    return super.appendCustomEntry(customType, data);
  }

  override appendSessionInfo(name: string): string {
    return super.appendSessionInfo(name);
  }

  override getSessionName(): string | undefined {
    return super.getSessionName();
  }

  override appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    return super.appendCustomMessageEntry(customType, content, display, details);
  }

  override getLeafId(): string | null {
    return super.getLeafId();
  }

  override getLeafEntry(): SessionEntry | undefined {
    return super.getLeafEntry();
  }

  override getEntry(id: string): SessionEntry | undefined {
    return super.getEntry(id);
  }

  override getChildren(parentId: string): SessionEntry[] {
    return super.getChildren(parentId);
  }

  override getLabel(id: string): string | undefined {
    return super.getLabel(id);
  }

  override appendLabelChange(targetId: string, label: string | undefined): string {
    return super.appendLabelChange(targetId, label);
  }

  override getBranch(fromId?: string): SessionEntry[] {
    return super.getBranch(fromId);
  }

  override buildSessionContext(): SessionContext {
    return super.buildSessionContext();
  }

  override getHeader(): SessionHeader | null {
    return super.getHeader();
  }

  override getEntries(): SessionEntry[] {
    return super.getEntries();
  }

  override getTree(): SessionTreeNode[] {
    return super.getTree();
  }

  override branch(branchFromId: string): void {
    super.branch(branchFromId);
  }

  override resetLeaf(): void {
    super.resetLeaf();
  }

  override branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    return super.branchWithSummary(branchFromId, summary, details, fromHook);
  }

  override createBranchedSession(leafId: string): string | undefined {
    return super.createBranchedSession(leafId);
  }

  static create(cwd: string, sessionDir?: string): SessionManager {
    const directory = sessionDir ?? getDefaultSessionDir(cwd);
    return new SessionManager(cwd, directory, undefined, true);
  }

  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
    const sqliteLoaded = loadSqliteMarkedSessionFile(
      path,
      (marker) => loadTranscriptEventsSync(marker) as FileEntry[],
      { cwdOverride },
    );
    if (sqliteLoaded) {
      return new SessionManager(
        sqliteLoaded.cwd,
        sessionDir ?? "",
        path,
        true,
        { entries: sqliteLoaded.entries, snapshot: undefined },
        { ...sqliteLoaded.sqliteMarker, sessionKey: sqliteLoaded.sessionKey },
      );
    }

    const loaded = revalidateLoadedSessionFile(path, loadEntriesFromFileWithSnapshot(path));
    const header = loaded.entries.find((entry) => entry.type === "session");
    const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
    const directory = sessionDir ?? resolve(path, "..");
    return new SessionManager(cwd, directory, path, true, loaded);
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd, "", undefined, false);
  }
}

export type ReadonlySessionManager = Pick<
  SessionManager,
  | "getCwd"
  | "getSessionDir"
  | "getSessionId"
  | "getSessionFile"
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getLabel"
  | "getBranch"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "getSessionName"
>;
