import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleMutation,
  ResetSessionEntryLifecycleResult,
  DeletedAgentSessionEntryPurgeParams,
  SessionArchivedTranscriptCleanupRule,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionLifecycleStoreTarget,
} from "./session-accessor.lifecycle-types.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "./types.js";

/**
 * Session access API for callers that need entries or transcripts without
 * depending on the persisted store layout. Callers provide stable session
 * identity, and this module resolves the current entry/transcript target while
 * preserving canonical-key, transcript-linking, and update-notification rules.
 *
 * This accessor is the permanent storage-neutral domain boundary for
 * session/transcript runtime access. Legacy JSON import remains doctor-only.
 */
export type SessionAccessScope = {
  /** Agent owner used when the session key does not already encode one. */
  agentId?: string;
  /**
   * Set false only for internal read-only hot paths that will not retain or
   * mutate the returned entry.
   */
  clone?: boolean;
  /** Environment override used when resolving agent-scoped store paths in tests/tools. */
  env?: NodeJS.ProcessEnv;
  /** Set false for metadata-only reads that do not need hydrated prompt refs. */
  hydrateSkillPromptRefs?: boolean;
  /** Use latest when the caller must bypass any in-process metadata snapshot. */
  readConsistency?: "latest";
  /** Canonical or alias session key for the entry being read or written. */
  sessionKey: string;
  /** Explicit store path for callers that already resolved the owning store. */
  storePath?: string;
};

export type LogicalSessionAccessScope = {
  /** Runtime config whose session store rules define the logical session owner. */
  cfg: OpenClawConfig;
  /** Environment override used when resolving configured/discovered agent stores. */
  env?: NodeJS.ProcessEnv;
  /** Canonical or alias session key for the logical entry being read or written. */
  sessionKey: string;
};

export type SessionEntryListScope = Partial<Omit<SessionAccessScope, "sessionKey">>;
export type SessionEntryStatus = NonNullable<SessionEntry["status"]>;

export type ResolvedSessionEntryAccessTarget = {
  /** Agent owner inferred from the canonical session key. */
  agentId: string;
  /** Canonical session key returned to callers even when an alias row won. */
  canonicalKey: string;
  /** Freshest matching entry, if any. */
  entry?: SessionEntry;
  /** Original caller-supplied key after trimming. */
  requestedKey: string;
  /** Persisted key for the selected row. */
  storeKey: string;
};

export type ResolvedSessionEntryStoreTarget = ResolvedSessionEntryAccessTarget & {
  storePath: string;
};

export type SessionEntryCandidateAccessScope = {
  /** Agent owner whose session store is searched. */
  agentId: string;
  /** Ordered session keys to test inside the resolved store. */
  candidateKeys: readonly string[];
  /** Runtime config whose session store rule selects the backend target. */
  cfg: OpenClawConfig;
  /** Environment override used when resolving agent-scoped store paths in tests/tools. */
  env?: NodeJS.ProcessEnv;
  /** Optional synthesized entry returned only when no candidate exists. */
  fallback?: {
    entry: SessionEntry;
    sessionKey: string;
  };
};

export type ResolvedSessionEntryCandidateTarget = {
  /** Agent owner whose session store produced this result. */
  agentId: string;
  /** Candidate key that selected the result, or the fallback key. */
  candidateKey: string;
  /** Session metadata cloned from storage or from the synthesized fallback. */
  entry: SessionEntry;
  /** False only for synthesized fallback entries that have not been written. */
  persisted: boolean;
  /** Persisted key selected by the backend, or the fallback key. */
  sessionKey: string;
};

export type ResolvedSessionEntryUpdateContext = Omit<ResolvedSessionEntryAccessTarget, "entry"> & {
  /** Mutable entry inside the storage operation. */
  entry: SessionEntry;
};

export type ResolvedSessionEntryUpdateResult<T> =
  | {
      canonicalKey: string;
      found: false;
    }
  | {
      canonicalKey: string;
      entry: SessionEntry;
      found: true;
      result: T;
      storeKey: string;
    };

export type SessionTranscriptAccessScope = Omit<SessionAccessScope, "sessionKey"> & {
  /** Deprecated transcript locator from older file-backed call sites. */
  sessionFile?: string;
  /** Runtime session id used to resolve the transcript identity. */
  sessionId: string;
  /** Required when resolving through session metadata; optional for legacy locators. */
  sessionKey?: string;
  /** Channel thread suffix used when deriving topic transcript paths. */
  threadId?: string | number;
};

export type SessionTranscriptRuntimeScope = SessionAccessScope & {
  /** Deprecated transcript locator from older file-backed call sites. */
  sessionFile?: string;
  sessionId: string;
  threadId?: string | number;
};

export type SessionTranscriptReadScope = Omit<SessionTranscriptRuntimeScope, "sessionKey"> & {
  /** Canonical key when the caller has a session-store identity for this read. */
  sessionKey?: string;
  /** Entry already loaded by hot callers; avoids rereading the session store. */
  sessionEntry?: Pick<SessionEntry, "sessionFile"> & Partial<Pick<SessionEntry, "sessionId">>;
};

export type SessionTranscriptReadTarget = Omit<
  SessionTranscriptRuntimeTarget,
  "agentId" | "sessionKey"
> & {
  agentId?: string;
  sessionKey?: string;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  /** Optional for appenders that resolve it from the session entry. */
  sessionId?: string;
};

export type SessionEntrySummary = {
  /** Persisted key for the entry. */
  sessionKey: string;
  /** Entry value cloned from the backing store unless the caller requested borrowed reads. */
  entry: SessionEntry;
};

export type SessionEntryReadView = {
  /** Row stored under the exact persisted key; no alias or canonical-key resolution. */
  get(sessionKey: string): SessionEntry | undefined;
  /** Every persisted row; call only when exact-key probes cannot settle the lookup. */
  entries(): SessionEntrySummary[];
};

/** Session entry read by the exact persisted session key, without alias resolution. */
export type ExactSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

/** Raw transcript record for non-message events; message records use appendTranscriptMessage. */
export type TranscriptEvent = unknown;

export type SessionTranscriptStats = {
  eventCount: number;
  lastMutationAtMs?: number;
  lastObservedMutationAtMs?: number;
  maxSeq: number;
  sizeBytes: number;
};

export type SessionTranscriptEventRow = {
  event: TranscriptEvent;
  seq: number;
};

/** Count, byte, and continuation bounds for one raw transcript page. */
export type SessionTranscriptRawDeltaLimits = {
  /** Opaque cursor returned by a prior page or reset result. */
  cursor?: string;
  /** Maximum serialized JSONL bytes returned by this page. */
  maxBytes?: number;
  /** Maximum number of events returned by this page. */
  maxEvents?: number;
};

/** Generation-aware outcome for one bounded raw transcript read. */
export type SessionTranscriptRawDeltaResult =
  | {
      kind: "page";
      /** Cursor positioned after the last returned event. */
      cursor: string;
      /** Ordered raw transcript events selected for this page. */
      events: SessionTranscriptEventRow[];
      /** True when another event remains after this page. */
      hasMore: boolean;
      /** First unread event size when it cannot fit under maxBytes. */
      requiredBytes?: number;
      /** Stored JSONL bytes represented by events. */
      serializedBytes: number;
    }
  | {
      kind: "reset";
      /** Fresh bootstrap cursor for the current generation. */
      cursor: string;
      /** Stable discontinuity that invalidated the supplied cursor. */
      reason: "generation_mismatch" | "invalid_cursor" | "scope_mismatch";
    }
  | { kind: "missing" };

/** Count, byte, and continuation bounds for one visible-message page. */
export type SessionTranscriptVisibleMessageDeltaLimits = {
  /** Opaque continuation cursor; store and return it unchanged. */
  cursor?: string;
  /** Maximum serialized JSONL bytes returned by this page. */
  maxBytes?: number;
  /** Maximum number of visible messages returned by this page. */
  maxMessages?: number;
};

/** One active-path message row selected from the materialized projection. */
export type SessionTranscriptVisibleMessageEventRow = SessionTranscriptEventRow & {
  /** Raw transcript sequence used only by the opaque continuation cursor. */
  eventSeq: number;
  /** Parent id after active-branch normalization; null for the visible root. */
  parentId: string | null;
};

/** Generation-aware outcome for one bounded visible-message read. */
export type SessionTranscriptVisibleMessageDeltaResult =
  | {
      kind: "page";
      /** Cursor positioned after the last returned visible message. */
      cursor: string;
      /** Ordered active-path message events selected for this page. */
      events: SessionTranscriptVisibleMessageEventRow[];
      /** True when another visible message remains after this page. */
      hasMore: boolean;
      /** First unread event size when it cannot fit under maxBytes. */
      requiredBytes?: number;
      /** Stored JSONL bytes represented by events. */
      serializedBytes: number;
    }
  | {
      kind: "reset";
      /** Fresh bootstrap cursor for the current visible generation. */
      cursor: string;
      /** Stable discontinuity that invalidated the supplied cursor. */
      reason:
        | "anchor_missing"
        | "anchor_moved"
        | "generation_mismatch"
        | "invalid_cursor"
        | "scope_mismatch";
    }
  | { kind: "missing" };

export type TranscriptMessageAppendOptions<TMessage> = {
  /** Runtime config used for message redaction and transcript header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /** How duplicate message idempotency keys are detected before append. */
  idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
  /** Provider/channel message payload to persist. */
  message: TMessage;
  /** Testable timestamp override for the generated transcript entry. */
  now?: number;
  /** Existing transcript event id owned by a caller with its own session tree. */
  eventId?: string;
  /** Existing parent id owned by a caller with its own session tree. */
  parentId?: string | null;
  /** Optional finalizer that runs after duplicate detection but before persistence. */
  prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
  /** Allow append without parent-link migration for large legacy linear transcripts. */
  useRawWhenLinear?: boolean;
};

export type TranscriptMessageAppendResult<TMessage> = {
  /** False when idempotency lookup found an existing transcript message. */
  appended: boolean;
  /** Redacted message payload as persisted or replayed from the transcript. */
  message: TMessage;
  /** Existing or newly generated transcript message id. */
  messageId: string;
};

/** Transcript update fields supplied by callers; the target is resolved here. */
export type TranscriptUpdatePayload = Partial<SessionTranscriptUpdate>;

export type LatestTranscriptAssistantText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type SessionTranscriptWriteLockAccessorContext = {
  appendMessage: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

export type SessionTranscriptWriteTransactionContext = {
  /** Canonical marker for the same agent database owned by the transaction. */
  sessionFile: string;
};

export type SessionTranscriptTurnUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptTurnMessageAppend = TranscriptMessageAppendOptions<unknown> & {
  /**
   * Runs inside the session writer queue before the SQLite transaction begins.
   * The commit phase revalidates session ownership and database idempotency
   * after asynchronous predicate work finishes.
   */
  shouldAppend?: (context: SessionTranscriptTurnWriteContext) => Promise<boolean> | boolean;
};

export type SessionTranscriptTurnWriteContext = {
  agentId?: string;
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
};

export type SessionTranscriptTurnPersistOptions = {
  /** Runtime config used for lock settings, redaction, and header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /**
   * Rejects the turn when the persisted session key no longer points at this
   * runtime session id. SQLite evaluates this guard inside the same queued
   * write as the transcript append and metadata touch.
   */
  expectedSessionId?: string;
  /** Rejects the turn when lifecycle ownership changed without rotating the session id. */
  expectedLifecycleRevision?: string;
  /** Rejects the turn unless the persisted row still has this exact lifecycle owner state. */
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  /** Lifecycle metadata committed when the guarded turn inserts or idempotently matches a message. */
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  /** Message rows to append under one transcript write lock. */
  messages: readonly SessionTranscriptTurnMessageAppend[];
  /** Controls whether the update event includes the last appended message. */
  updateMode?: SessionTranscriptTurnUpdateMode;
  /** Emit file-only updates even when every candidate message was skipped. */
  publishWhen?: "always" | "when-appended";
  /**
   * Touch updatedAt/sessionFile metadata after appending.
   * SQLite implementation note: transcript row append(s) plus this session
   * metadata touch should be one SQLite write transaction; publish happens
   * after that transaction commits.
   */
  touchSessionEntry?: boolean;
};

export type SessionTranscriptTurnPersistResult = {
  appendedCount: number;
  messages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

export type SessionTranscriptRuntimeTarget = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
};

export type SessionTranscriptManualTrimResult =
  | {
      compacted: false;
      reason: "no transcript";
    }
  | {
      compacted: false;
      kept: number;
    }
  | {
      archived: string;
      compacted: true;
      kept: number;
    };

export type SessionTranscriptManualTrimPreflightResult =
  | Extract<SessionTranscriptManualTrimResult, { compacted: false }>
  | {
      compacted: true;
    };

export type SessionEntryUpdateOptions = {
  /** Skip prune/cap/rotation maintenance for specialized internal updates. */
  skipMaintenance?: boolean;
  /** Let the writer cache retain the updated object without cloning. */
  takeCacheOwnership?: boolean;
  /** Throw when best-effort store recovery cannot confirm the requested write. */
  requireWriteSuccess?: boolean;
};

export type SessionAbortTargetCutoff = {
  messageSid?: string;
  timestamp?: number;
};

export type SessionAbortTargetContext = {
  entry: SessionEntry;
  sessionKey: string;
};

export type SessionAbortTargetIdentity = SessionAbortTargetContext & {
  sessionId?: string;
};

export type SessionAbortTargetResult = SessionAbortTargetIdentity & {
  persisted: boolean;
  persistenceError?: string;
};

export type SessionLifecycleTranscriptInfo = {
  sessionFile?: string;
  transcriptArchived?: boolean;
};

export type ReplySessionInitializationSnapshot = {
  currentEntry?: SessionEntry;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  revision: string;
};

export type ReplySessionInitializationCommitContext = {
  currentEntry?: SessionEntry;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry: SessionEntry;
};

export type ReplySessionInitializationCommitResult =
  | {
      ok: true;
      previousSessionTranscript: SessionLifecycleTranscriptInfo;
      sessionEntry: SessionEntry;
      sessionStoreView: Record<string, SessionEntry>;
    }
  | {
      ok: false;
      currentEntry?: SessionEntry;
      reason: "stale-snapshot";
      revision: string;
    };

export type SessionEntryPatchOptions = {
  /** Entry to synthesize when a patch operation is allowed to create. */
  fallbackEntry?: SessionEntry;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  /** Keep the previous updatedAt value when the patch should not count as activity. */
  preserveActivity?: boolean;
  /** Throw when best-effort store recovery cannot confirm the requested write. */
  requireWriteSuccess?: boolean;
  /** Replace the whole entry instead of merging the returned patch. */
  replaceEntry?: boolean;
  /** Skip prune/cap/rotation maintenance for specialized internal updates. */
  skipMaintenance?: boolean;
  /** Let the writer cache retain the updated object without cloning. */
  takeCacheOwnership?: boolean;
};

export type SessionEntryPatchContext = {
  /** Present when the patched entry already existed before fallback synthesis. */
  existingEntry?: SessionEntry;
};

export type SessionEntryPatchResult = {
  /** Exact persisted key for the patched entry after alias normalization. */
  sessionKey: string;
  /** Persisted entry returned by the backing store. */
  entry: SessionEntry;
};

export type SessionEntryTargetPatchScope = {
  /** Agent owner used when resolving custom/shared legacy store paths. */
  agentId?: string;
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type SessionEntryReplacementSnapshot = {
  /** Exact persisted key for the candidate row. */
  sessionKey: string;
  /** Detached entry snapshot; mutating it does not persist unless returned as a replacement. */
  entry: SessionEntry;
};

export type SessionEntryReplacement = {
  /** Exact persisted key to replace. Missing keys are ignored. */
  sessionKey: string;
  /** Full replacement row to persist for this transaction. */
  entry: SessionEntry;
};

export type SessionEntryReplacementUpdate<T> = {
  /** Caller-owned result returned after replacements are persisted. */
  result: T;
  /** Exact rows to replace inside the storage transaction. */
  replacements?: Iterable<SessionEntryReplacement>;
};

/** File-backed checkpoint transcript fork produced by the checkpoint storage boundary. */
export type SessionCompactionCheckpointForkedTranscript = {
  sessionFile: string;
  sessionId: string;
  totalTokens?: number;
};

/** Result of resolving and copying checkpoint transcript content for branch/restore. */
export type SessionCompactionCheckpointTranscriptForkResult =
  | { status: "created"; transcript: SessionCompactionCheckpointForkedTranscript }
  | { status: "missing-boundary" }
  | { status: "failed" };

/** Decision made before inheriting parent context into a child session. */
export type SessionParentForkDecision =
  | {
      status: "fork";
      maxTokens: number;
      parentTokens?: number;
    }
  | {
      status: "skip";
      reason: "parent-too-large";
      maxTokens: number;
      parentTokens: number;
      message: string;
    };

/** SQLite transcript identity created for a child fork. */
export type ParentForkedSessionTranscript = {
  sessionFile: string;
  sessionId: string;
};

export type ForkSessionFromParentTranscriptResult =
  | {
      status: "created";
      transcript: ParentForkedSessionTranscript;
    }
  | { status: "missing-parent" }
  | { status: "failed" };

export type ForkSessionFromParentTranscriptParams = {
  agentId?: string;
  parentEntry: SessionEntry;
  parentSessionKey: string;
  sessionKey: string;
  storePath: string;
  /** Stable target identity for lifecycle-owned hidden or resumable sessions. */
  targetSessionId?: string;
  /** Cross-agent forks land the child transcript in the target agent's store. */
  targetStorePath?: string;
};

export type ForkSessionEntryFromParentTargetResult =
  | {
      status: "forked";
      fork: ParentForkedSessionTranscript;
      parentEntry: SessionEntry;
      sessionEntry: SessionEntry;
      decision: Extract<SessionParentForkDecision, { status: "fork" }>;
    }
  | {
      status: "skipped";
      reason: "existing-entry" | "decision-skip";
      parentEntry?: SessionEntry;
      sessionEntry: SessionEntry;
      decision?: SessionParentForkDecision;
    }
  | { status: "missing-entry" }
  | { status: "missing-parent" }
  | { status: "failed" };

export type ForkSessionEntryFromParentTargetParams = {
  agentId?: string;
  decisionSkipPatch?: (params: {
    decision: Extract<SessionParentForkDecision, { status: "skip" }>;
    entry: SessionEntry;
    parentEntry: SessionEntry;
  }) => Partial<SessionEntry> | null;
  fallbackEntry?: SessionEntry;
  parentTarget: SessionLifecycleStoreTarget;
  patch?: (params: {
    entry: SessionEntry;
    parentEntry: SessionEntry;
    fork: ParentForkedSessionTranscript;
    decision: Extract<SessionParentForkDecision, { status: "fork" }>;
  }) => Partial<SessionEntry>;
  sessionTarget: SessionLifecycleStoreTarget;
  skipForkWhen?: (entry: SessionEntry) => boolean;
  skipPatch?: (entry: SessionEntry) => Partial<SessionEntry> | null;
  storePath: string;
};

/** Result of applying a checkpoint branch or restore mutation to session storage. */
export type SessionCompactionCheckpointMutationResult =
  | {
      status: "created";
      key: string;
      checkpoint: SessionCompactionCheckpoint;
      entry: SessionEntry;
    }
  | { status: "missing-session" }
  | { status: "missing-checkpoint" }
  | { status: "missing-boundary" }
  | { status: "model-selection-locked" }
  | { status: "failed" };

export type SessionMessageCutMutationResult =
  | {
      status: "created";
      key: string;
      entry: SessionEntry;
      editorText?: string;
    }
  | { status: "missing-session" }
  | { status: "missing-entry" }
  | { status: "not-user-message" }
  | { status: "off-active-path" }
  | { status: "unsupported-storage" }
  | { status: "failed" };

export type SessionMessageCutMutationParams = {
  agentId?: string;
  creation?: {
    via: import("./session-entry-provenance.js").SessionCreatedVia;
    actor?: import("./session-entry-provenance.js").SessionCreatedActor;
  };
  entryId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  sessionStoreKey?: string;
  storePath?: string;
  targetKey?: string;
};

export type SessionBranchSummary = {
  leafEntryId: string;
  headline: string;
  messageCount: number;
  updatedAt?: string;
  active: boolean;
};

export type SessionBranchListResult =
  | { status: "ok"; branches: SessionBranchSummary[] }
  | { status: "missing-session" }
  | { status: "unsupported-storage" }
  | { status: "failed" };

export type SessionBranchListParams = Pick<
  SessionMessageCutMutationParams,
  "agentId" | "env" | "sessionKey" | "sessionStoreKey" | "storePath"
>;

export type SessionBranchSwitchMutationResult =
  | {
      status: "created";
      key: string;
      entry: SessionEntry;
    }
  | { status: "missing-session" }
  | { status: "missing-entry" }
  | { status: "not-branch-tip" }
  | { status: "already-active" }
  | { status: "unsupported-storage" }
  | { status: "failed" };

export type SessionBranchSwitchMutationParams = Omit<
  SessionMessageCutMutationParams,
  "entryId" | "targetKey"
> & {
  leafEntryId: string;
};

export type SessionCompactionCheckpointEntryBuildContext = {
  /** Checkpoint row selected from the current persisted session entry. */
  checkpoint: SessionCompactionCheckpoint;
  /** Persisted entry that owns the selected checkpoint. */
  currentEntry: SessionEntry;
  /** Forked transcript identity created from the stored checkpoint boundary. */
  forkedTranscript: SessionCompactionCheckpointForkedTranscript;
};

export type SessionCompactionCheckpointTranscriptForker = (
  checkpoint: SessionCompactionCheckpoint,
) => Promise<SessionCompactionCheckpointTranscriptForkResult>;

export type SessionCompactionCheckpointEntryBuilder = (
  context: SessionCompactionCheckpointEntryBuildContext,
) => Promise<SessionEntry> | SessionEntry;

export type BranchSessionFromCompactionCheckpointParams = {
  /** Checkpoint id stored on the source session entry. */
  checkpointId: string;
  /** Builds the branched session entry from the forked transcript. */
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  /** Copies transcript content through the stored checkpoint boundary. */
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  /** Persisted key for the new checkpoint branch. */
  nextKey: string;
  /** Canonical key used as the branch parent. */
  sourceKey: string;
  /** Actual persisted key to read when a legacy alias still owns the row. */
  sourceStoreKey?: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type RestoreSessionFromCompactionCheckpointParams = {
  /** Checkpoint id stored on the current session entry. */
  checkpointId: string;
  /** Builds the restored session entry from the forked transcript. */
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  /** Copies transcript content through the stored checkpoint boundary. */
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  /** Canonical key to replace with the restored checkpoint state. */
  sessionKey: string;
  /** Actual persisted key to read when a legacy alias still owns the row. */
  sessionStoreKey?: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type TemporarySessionMappingPreservationResult<T> = {
  /** Result returned by the operation while the temporary mapping may exist. */
  result: T;
  /** Snapshot failure; callers may continue when temporary cleanup is best-effort. */
  snapshotFailure?: string;
  /** Restore/delete failure for the original temporary mapping state. */
  restoreFailure?: string;
};

export type SessionEntryCreateWithTranscriptContext = {
  /** Current entry under the requested key before creation, if any. */
  existingEntry?: SessionEntry;
  /** Current entries snapshot for validation rules such as label uniqueness. */
  sessionEntries: Record<string, SessionEntry>;
};

export type SessionEntryCreateWithTranscriptResult<TError = string> =
  | { ok: true; entry: SessionEntry; sessionFile: string }
  | { ok: false; error: TError; phase: "entry" }
  | { ok: false; error: string; phase: "transcript" };

export type SessionEntryCreateWithTranscriptPrepareResult<TError = string> =
  | { ok: true; entry: SessionEntry }
  | { ok: false; error: TError };

export type SessionEntryCreateWithTranscriptOptions = {
  /** Protect the newly created row from maintenance during its initial write. */
  activeSessionKey?: string;
  /** SQLite commits are authoritative; retained for the shared caller contract. */
  requireWriteSuccess?: boolean;
};

export type SessionPatchProjectionSnapshot = {
  entries: ReadonlyArray<{ sessionKey: string; entry: SessionEntry }>;
};

export type SessionPatchProjectionTarget = {
  candidateKeys?: readonly string[];
  primaryKey: string;
};

export type SessionPatchProjectionContext = SessionPatchProjectionSnapshot &
  SessionPatchProjectionTarget & {
    existingEntry?: SessionEntry;
  };

export type SessionPatchProjectionFailure = { ok: false };

export type SessionPatchProjectionResult<TFailure extends SessionPatchProjectionFailure> =
  | { ok: true; entry: SessionEntry }
  | TFailure;

export type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionLifecycleStoreTarget,
};

export type {
  DeletedAgentSessionEntryPurgeParams,
  SessionArchivedTranscriptCleanupRule,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
};

export type ResetSessionEntryLifecycleParams = {
  /** Preserve legacy rotation archival unless the caller appended an in-log boundary. */
  archivePreviousTranscript?: boolean;
  /** Runs after the persisted entry changes and any requested archival completes. */
  afterEntryMutation?: (mutation: ResetSessionEntryLifecycleMutation) => Promise<void> | void;
  /** Agent owner used to resolve backend transcript artifacts. */
  agentId?: string;
  /** Builds the persisted replacement entry from the current backend row. */
  buildNextEntry: (context: {
    currentEntry?: SessionEntry;
    primaryKey: string;
  }) => Promise<SessionEntry> | SessionEntry;
  /** Atomically append this boundary with the reset entry mutation. */
  resetBoundaryReason?: import("./session-reset-boundary-event.js").SessionResetBoundaryReason;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type DeleteSessionEntryLifecycleParams = {
  /** Agent owner used to resolve backend transcript artifacts. */
  agentId?: string;
  /** Whether transcript artifacts should be archived/deleted with the entry. */
  archiveTranscript: boolean;
  /** Delete transcript rows without writing an archive artifact. */
  deleteTranscriptWithoutArchive?: boolean;
  /** Optional exact row guard checked under the storage writer lock. */
  expectedEntry?: SessionEntry;
  /** Optional provider-run identity guard checked under the storage writer lock. */
  expectedSessionId?: string | null;
  /** Optional owner revision guard checked under the storage writer lock. */
  expectedLifecycleRevision?: string;
  /** Optional persisted revision guard checked under the storage writer lock. */
  expectedUpdatedAt?: number;
  /** Fail when the underlying store cannot confirm a durable write. */
  requireWriteSuccess?: boolean;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type CanonicalizeSessionEntryAliasesResult = {
  canonicalKey: string;
  entry?: SessionEntry;
};
