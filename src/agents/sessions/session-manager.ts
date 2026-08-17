/**
 * Session tree manager backed by an explicit SQLite transcript identity.
 *
 * The public facade lives here; codec, storage, persistence, and branching
 * behavior are split into focused internal modules.
 */
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsWithSnapshotSync,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { SqliteTranscriptSnapshotRow } from "../../config/sessions/session-accessor.sqlite-read.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { Message } from "../../llm/types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionManagerBranching } from "./session-manager-branching.js";
import type { SessionManagerPersistenceTarget } from "./session-manager-core.js";
import type { AppendPersistenceOptions, FileEntry } from "./session-manager-types.js";

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
    loadedSnapshot?: SqliteTranscriptSnapshotRow[],
  ) {
    super(cwd, persistenceTarget, loadedEntries, loadedSnapshot);
  }

  /** Makes pending append-oriented persistence durable without rewriting committed entries. */
  override flushPendingPersistence(): void {
    super.flushPendingPersistence();
  }

  // Worker rollback instrumentation wraps the method on this public prototype.
  override appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    return super.appendMessage(message, options);
  }

  override appendMessageWithTranscriptAnchor(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ) {
    return super.appendMessageWithTranscriptAnchor(message, options);
  }

  static open(target: SessionTranscriptRuntimeTarget, cwdOverride?: string): SessionManager {
    // Load events and the row snapshot from one SQLite read transaction: reading them
    // separately would leave a gap in which a foreign commit lands after the entries
    // read but before the snapshot read, so it is absent from `entries` yet present in
    // the "expected" snapshot -- and a later rewrite would silently delete it.
    const { events, snapshot } = loadTranscriptEventsWithSnapshotSync(target);
    const entries = events as FileEntry[];
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(
      cwdOverride ?? header?.cwd ?? process.cwd(),
      target,
      entries,
      snapshot,
    );
  }

  /** Appends to the current transcript leaf without hydrating its history. */
  static appendMessageToTranscript(
    target: SessionTranscriptRuntimeTarget,
    message: Message | CustomMessage | BashExecutionMessage,
    options?: Pick<AppendPersistenceOptions, "config">,
  ): string {
    const result = appendTranscriptMessageSync(target, {
      cwd: process.cwd(),
      message,
      ...(options?.config ? { config: options.config } : {}),
    });
    if (!result) {
      throw new Error(`Session transcript message was not persisted: ${target.sessionId}`);
    }
    return result.messageId;
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd);
  }

  static fromEntries(entries: readonly unknown[], cwdOverride?: string): SessionManager {
    const fileEntries = structuredClone(entries) as FileEntry[];
    const header = fileEntries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(cwdOverride ?? header?.cwd ?? process.cwd(), undefined, fileEntries);
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
