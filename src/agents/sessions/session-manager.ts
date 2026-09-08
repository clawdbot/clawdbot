/**
 * Session tree manager backed by an explicit SQLite transcript identity.
 *
 * The public facade lives here; codec, storage, persistence, and branching
 * behavior are split into focused internal modules.
 */
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  appendTranscriptMessageSync,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { prepareTranscriptRewriteSync } from "../../config/sessions/session-accessor.sqlite-branch-rewrite.js";
import {
  readSessionTranscriptContextMessages,
  readSessionTranscriptModelContext,
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextAnchor,
  validateSessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { assertCurrentSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-model-context-worker-runtime.js";
import {
  resolveSessionTranscriptReadFence,
  withSessionContextAdmission,
} from "../../config/sessions/session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { Message } from "../../llm/types.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { SessionManagerBranching } from "./session-manager-branching.js";
import type {
  SessionManagerBoundedContext,
  SessionManagerBoundedContextLimits,
  SessionManagerPersistenceTarget,
} from "./session-manager-core.js";
import type { AppendPersistenceOptions, FileEntry, SessionEntry } from "./session-manager-types.js";

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
    boundedContext?: SessionManagerBoundedContext,
    transcriptMutationAt?: number | null,
    version?: SessionTranscriptContextVersion,
  ) {
    super(cwd, persistenceTarget, loadedEntries, boundedContext, transcriptMutationAt, version);
    this.retainTranscriptWriter();
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

  /** Prepare off-store; publish the suffix and adopt memory at the same outer commit edge. */
  prepareTranscriptRewrite() {
    this.assertTranscriptWriteActive();
    const publish = this.persistenceTarget
      ? prepareTranscriptRewriteSync(
          this.persistenceTarget,
          this.appendParentId,
          () => this.assertTranscriptWriteActive(),
          this.transcriptVersion,
        )
      : undefined;
    const prepared = SessionManager.inMemory(this.cwd);
    Object.assign(prepared, structuredClone(this.captureTranscriptView()));
    const initialEntryCount = prepared.fileEntries.length;
    const persistedBoundaryCount = prepared.persistedBoundaryCount;
    prepared.persistedBoundaryCount = undefined;
    const loadedBoundaryCount = prepared.getBoundaryCount();
    return {
      sessionManager: prepared,
      commit: (rewrittenEntryIds: ReadonlyMap<string, string>) => {
        const entries = prepared.fileEntries
          .slice(initialEntryCount)
          .filter((entry) => entry.type !== "session");
        const sources = new Map<string, SessionEntry>();
        for (const [sourceId, destination] of rewrittenEntryIds) {
          const source = this.byId.get(sourceId);
          if (!source) {
            throw new Error("Transcript rewrite source is not in the loaded view");
          }
          sources.set(destination, source);
        }
        const first = entries[0];
        const source = first && sources.get(first.id);
        const parentId = source ? this.boundedParentIds.get(source.id) : undefined;
        // The bounded reader owns logical ancestry, including parents outside its payload window.
        if (first?.parentId === null && parentId !== undefined) {
          first.parentId = parentId;
          prepared.boundedParentIds.set(first.id, first.parentId);
        }
        // A maintenance branch may cross a reset. Side entries preserve its
        // explicit ancestry; ordinary appends would normalize onto the old leaf.
        for (const entry of entries) {
          entry.appendMode = "side";
        }
        // Reconstruct with the reader's canonical reset/leaf rules, then retain
        // the bounded reader's ancestry for payloads absent from the loaded view.
        prepared.buildIndex();
        for (const [id, parent] of this.opaqueParentsById) {
          prepared.opaqueParentsById.set(id, parent);
        }
        for (const [id, parent] of this.logicalParentsById) {
          prepared.logicalParentsById.set(id, parent);
        }
        const last = entries.at(-1);
        const leaf = last
          ? prepared.appendLeafControl({ targetId: last.id, appendParentId: last.id })
          : undefined;
        if (persistedBoundaryCount !== undefined) {
          prepared.persistedBoundaryCount =
            persistedBoundaryCount + prepared.getBoundaryCount() - loadedBoundaryCount;
        }
        const adopt = (version = prepared.transcriptVersion) => {
          prepared.transcriptVersion = version;
          prepared.transcriptMutationAt = version?.updatedAt;
          Object.assign(this, prepared.captureTranscriptView());
        };
        if (publish) {
          publish(leaf ? [...entries, leaf] : entries, sources, adopt);
        } else {
          adopt();
        }
      },
    };
  }

  static open(
    target: SessionTranscriptRuntimeTarget,
    cwdOverride?: string,
    contextLimits?: SessionManagerBoundedContextLimits,
  ): SessionManager {
    if (contextLimits) {
      return SessionManager.openBounded(target, {
        ...contextLimits,
        ...(cwdOverride !== undefined ? { cwd: cwdOverride } : {}),
      });
    }
    const snapshot = loadTranscriptReadSnapshotSync(target);
    const entries = snapshot.events as FileEntry[];
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(
      cwdOverride ?? header?.cwd ?? process.cwd(),
      target,
      entries,
      undefined,
      snapshot.version.updatedAt,
      snapshot.version,
    );
  }

  /** Opens only the selected model-context tail while preserving the complete durable transcript. */
  static openBounded(
    target: SessionTranscriptRuntimeTarget,
    options: SessionManagerBoundedContextLimits & { cwd?: string; onTruncated?: () => void },
  ): SessionManager {
    const { cwd, onTruncated, ...limits } = options;
    const context = readSessionTranscriptBoundedActiveContextCore(target, limits);
    if (context.truncated) {
      onTruncated?.();
    }
    // SAFETY: The accessor returns the same persisted transcript event union consumed by open().
    const entries = context.events as FileEntry[];
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(cwd ?? header?.cwd ?? process.cwd(), target, entries, {
      ...context,
      limits,
    });
  }

  /** Consumes a fresh bounded read as a detached branch, without copying its owned payloads. */
  static openDetachedBounded(
    target: SessionTranscriptRuntimeTarget,
    options: Parameters<typeof SessionManager.openBounded>[1],
  ): SessionManager {
    const source = SessionManager.openBounded(target, options);
    // Normalize opaque parents and retained cuts before discarding persistence and bounded state.
    return SessionManager.fromSelectedEntries(
      [source.getHeader(), ...source.getBranch()],
      source.getCwd(),
    );
  }

  /** Detached model view: selected payloads plus lightweight ancestry, never raw replay evidence. */
  static openModelContext(
    target: SessionTranscriptRuntimeTarget,
    options: {
      cwd?: string;
      admission?: UserTurnTranscriptAdmissionReceipt;
      through?: TranscriptEntryAnchor;
    } = {},
  ): SessionManager {
    const context = withSessionContextAdmission(target, options.admission, () =>
      readSessionTranscriptModelContext(target, options.through),
    );
    return SessionManager.fromSelectedEntries(context.events, options.cwd);
  }

  /** The same detached model view, with durable transcript scanning off the event loop. */
  static async openModelContextAsync(
    target: SessionTranscriptRuntimeTarget,
    options: {
      cwd?: string;
      admission?: UserTurnTranscriptAdmissionReceipt;
      signal?: AbortSignal;
      through?: TranscriptEntryAnchor;
    } = {},
  ): Promise<SessionManager> {
    const readTarget = { ...target };
    const receipt = options.admission ?? resolveSessionTranscriptReadFence(readTarget);
    const admission = receipt ? { ...receipt } : undefined;
    const through = options.through ? { ...options.through } : undefined;
    const context = await withSessionContextAdmission(readTarget, admission, () =>
      readSessionTranscriptModelContextAsync(readTarget, admission, options.signal, through),
    );
    options.signal?.throwIfAborted();
    // Even process-local reads yield here. Admitted history may exclude later
    // appends; unadmitted context must still match the snapshot being accepted.
    if (admission) {
      validateSessionTranscriptContextAdmission(readTarget, admission);
    } else if (!through) {
      validateSessionTranscriptContextVersion(readTarget, context.version);
    }
    if (through) {
      validateSessionTranscriptContextAnchor(readTarget, through);
    }
    return SessionManager.fromSelectedEntries(context.events, options.cwd);
  }

  private static fromSelectedEntries(contextEntries: unknown[], cwd?: string): SessionManager {
    // SAFETY: The transcript owner preserves the entry union; the constructor applies the normal codec.
    const entries = contextEntries as FileEntry[];
    const header = entries.find((entry) => entry.type === "session");
    if (entries.length > 0) {
      assertCurrentSessionTranscriptHeader(header);
    }
    const manager = new SessionManager(cwd ?? header?.cwd ?? process.cwd(), undefined, entries);
    manager.adoptSelectedTranscriptPath(
      manager.appendParentId,
      [...manager.byId].map(([id, entry]) => [id, entry.parentId]),
    );
    return manager;
  }

  /** Synchronously consumes full-fidelity context; its iterator closes with the read snapshot. */
  static readSessionContext<T>(
    target: SessionTranscriptRuntimeTarget,
    read: (messages: Iterable<AgentMessage>, header: unknown) => T,
    options: { admission?: UserTurnTranscriptAdmissionReceipt } = {},
  ): T {
    return withSessionContextAdmission(target, options.admission, () =>
      readSessionTranscriptContextMessages(target, read),
    );
  }

  /** Appends to the current transcript leaf without hydrating its history. */
  static appendMessageToTranscript(
    target: SessionTranscriptRuntimeTarget,
    message: Message | CustomMessage | BashExecutionMessage,
    options?: Pick<AppendPersistenceOptions, "config">,
  ): string {
    const outcome = appendTranscriptMessageSync(target, {
      cwd: process.cwd(),
      message,
      ...(options?.config ? { config: options.config } : {}),
    });
    if (!outcome.ok) {
      throw new Error("Session transcript message was not persisted", { cause: outcome.error });
    }
    const result = outcome.value;
    if (!result) {
      throw new Error("Session transcript message was not persisted");
    }
    return result.messageId;
  }

  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd);
  }

  static fromEntries(entries: readonly unknown[], cwdOverride?: string): SessionManager {
    return SessionManager.fromOwnedEntries(structuredClone(entries), cwdOverride);
  }

  private static fromOwnedEntries(
    entries: readonly unknown[],
    cwdOverride?: string,
  ): SessionManager {
    const fileEntries = entries as FileEntry[];
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
