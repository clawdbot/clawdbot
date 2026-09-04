/**
 * Session tree manager backed by an explicit SQLite transcript identity.
 *
 * The public facade lives here; codec, storage, persistence, and branching
 * behavior are split into focused internal modules.
 */
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import {
  readSessionTranscriptContextMessages,
  readSessionTranscriptModelContext,
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-model-context-worker-runtime.js";
import {
  resolveSessionTranscriptReadFence,
  withSessionContextAdmission,
} from "../../config/sessions/session-transcript-read-fence.js";
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
    boundedContext?: SessionManagerBoundedContext,
  ) {
    super(cwd, persistenceTarget, loadedEntries, boundedContext);
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
    const entries = loadTranscriptEventsSync(target) as FileEntry[];
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    return new SessionManager(cwdOverride ?? header?.cwd ?? process.cwd(), target, entries);
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

  /** Detached model view: selected payloads plus lightweight ancestry, never raw replay evidence. */
  static openModelContext(
    target: SessionTranscriptRuntimeTarget,
    options: {
      cwd?: string;
      admission?: UserTurnTranscriptAdmissionReceipt;
    } = {},
  ): SessionManager {
    const context = withSessionContextAdmission(target, options.admission, () =>
      readSessionTranscriptModelContext(target),
    );
    return SessionManager.fromModelContextEntries(context.events, options.cwd);
  }

  /** The same detached model view, with durable transcript scanning off the event loop. */
  static async openModelContextAsync(
    target: SessionTranscriptRuntimeTarget,
    options: {
      cwd?: string;
      admission?: UserTurnTranscriptAdmissionReceipt;
      signal?: AbortSignal;
    } = {},
  ): Promise<SessionManager> {
    const readTarget = { ...target };
    const receipt = options.admission ?? resolveSessionTranscriptReadFence(readTarget);
    const admission = receipt ? { ...receipt } : undefined;
    const context = await withSessionContextAdmission(readTarget, admission, () =>
      readSessionTranscriptModelContextAsync(readTarget, admission, options.signal),
    );
    options.signal?.throwIfAborted();
    // Even process-local reads yield here. Admitted history may exclude later
    // appends; unadmitted context must still match the snapshot being accepted.
    if (admission) {
      validateSessionTranscriptContextAdmission(readTarget, admission);
    } else {
      validateSessionTranscriptContextVersion(readTarget, context.version);
    }
    return SessionManager.fromModelContextEntries(context.events, options.cwd);
  }

  private static fromModelContextEntries(contextEntries: unknown[], cwd?: string): SessionManager {
    // SAFETY: The transcript owner preserves the entry union; the constructor applies the normal codec.
    const entries = contextEntries as FileEntry[];
    const header = entries.find((entry) => entry.type === "session");
    if (entries.length > 0 && (!header || (header.version ?? 1) < CURRENT_SESSION_VERSION)) {
      throw new Error(
        "Persisted legacy session transcripts require doctor/import migration before runtime use",
      );
    }
    return new SessionManager(cwd ?? header?.cwd ?? process.cwd(), undefined, entries);
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
