/**
 * Session tree manager backed by an explicit SQLite transcript identity.
 *
 * The public facade lives here; codec, storage, persistence, and branching
 * behavior are split into focused internal modules.
 */
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ImageContent, Message, TextContent } from "../../llm/types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionManagerBranching } from "./session-manager-branching.js";
import type { SessionManagerPersistenceTarget } from "./session-manager-core.js";
import type {
  AppendPersistenceOptions,
  FileEntry,
  NewSessionOptions,
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
  ResetReason,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionLeafControl,
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
export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  FileEntry,
  LabelEntry,
  ModelChangeEntry,
  NewSessionOptions,
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
  ResetEntry,
  ResetReason,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfoEntry,
  SessionLeafControl,
  SessionMessageEntry,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
} from "./session-manager-types.js";

export class SessionManager extends SessionManagerBranching {
  private constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: FileEntry[],
  ) {
    super(cwd, persistenceTarget, loadedEntries);
  }

  override setSessionTarget(target: SessionManagerPersistenceTarget): void {
    super.setSessionTarget(target);
  }

  override newSession(options?: NewSessionOptions): string | undefined {
    return super.newSession(options);
  }

  override clearPreservedOpaqueFileEntries(): void {
    super.clearPreservedOpaqueFileEntries();
  }

  override getPersistedEntries(): unknown[] {
    return super.getPersistedEntries();
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

  override getSessionId(): string {
    return super.getSessionId();
  }

  override getSessionTarget(): SessionManagerPersistenceTarget | undefined {
    return super.getSessionTarget();
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

  override appendResetBoundary(reason: ResetReason, firstKeptEntryId?: string): string {
    return super.appendResetBoundary(reason, firstKeptEntryId);
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

  override getAppendParentId(): string | null {
    return super.getAppendParentId();
  }

  override getAppendMode(): "side" | undefined {
    return super.getAppendMode();
  }

  override appendLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): SessionLeafControl {
    return super.appendLeafControl(params);
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

  override getBoundaryCount(): number {
    return super.getBoundaryCount();
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

  static open(target: SessionTranscriptRuntimeTarget, cwdOverride?: string): SessionManager {
    const entries = loadTranscriptEventsSync(target) as FileEntry[];
    const header = entries.find((entry) => entry.type === "session");
    return new SessionManager(cwdOverride ?? header?.cwd ?? process.cwd(), target, entries);
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd);
  }

  static fromEntries(entries: readonly unknown[], cwdOverride?: string): SessionManager {
    const fileEntries = entries as readonly FileEntry[];
    const header = fileEntries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(cwdOverride ?? header?.cwd ?? process.cwd(), undefined, [
      ...fileEntries,
    ]);
  }
}

export type ReadonlySessionManager = Pick<
  SessionManager,
  | "getCwd"
  | "getSessionId"
  | "getSessionTarget"
  | "getLeafId"
  | "getAppendParentId"
  | "getAppendMode"
  | "getLeafEntry"
  | "getEntry"
  | "getLabel"
  | "getBranch"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "getSessionName"
>;
