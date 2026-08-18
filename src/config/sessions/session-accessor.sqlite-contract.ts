import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type {
  DeletedAgentSessionEntryPurgeParams,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionLifecycleStoreTarget,
} from "./session-accessor.lifecycle-types.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionAccessScope = {
  agentId?: string;
  clone?: boolean;
  /** Fixed-store ownership is explicit; omitted values use the storage resolver's legacy-main contract. */
  defaultAgentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

export type SessionTranscriptAccessScope = Omit<SessionAccessScope, "sessionKey"> & {
  sessionFile?: string;
  sessionId: string;
  sessionKey?: string;
  threadId?: string | number;
};

type SessionTranscriptRuntimeScope = SessionAccessScope & {
  sessionFile?: string;
  sessionId: string;
  threadId?: string | number;
};

export type SessionTranscriptReadScope = Omit<SessionTranscriptRuntimeScope, "sessionKey"> & {
  sessionKey?: string;
  sessionEntry?: Partial<Pick<SessionEntry, "sessionId">>;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  sessionId?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
};

export type ExactSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

export type SessionEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

export type SessionEntryStatus = NonNullable<SessionEntry["status"]>;

export type SessionTranscriptInstance = SessionEntrySummary & {
  /** Stable transcript identity, including rotated history for one logical session key. */
  sessionId: string;
  /** True when this transcript instance was owned by an ACP runtime. */
  acpOwned: boolean;
  /** True when exclusion-sensitive session ownership was captured for this transcript id. */
  provenanceKnown: boolean;
  /** Activity timestamp for this transcript instance, not the current logical session row. */
  updatedAtMs: number;
};

export type TranscriptEventAppendOptions = {
  appendIntent?: "active-branch";
  /** Synchronous authority check run inside the append transaction. */
  beforeCommitInTransaction?: () => void;
  /**
   * The caller's last known-good transcript row snapshot, from an earlier
   * `onCommittedSnapshot` or `readTranscriptSnapshotSync`. When provided, it is
   * revalidated against the current rows *before* this append: if a foreign
   * process committed a row since that snapshot was taken, `onCommittedSnapshot`
   * is not invoked for this append, so the caller's stale snapshot is left in
   * place instead of being silently replaced by one that absorbed the foreign
   * row without it ever being added to the caller's own in-memory entries. A
   * later `replaceTranscriptEventsSync` call against that stale snapshot then
   * detects the drift and fails instead of dropping the foreign row.
   */
  expectedSnapshot?: readonly SqliteTranscriptSnapshotRow[];
  /**
   * Invoked synchronously inside the append's own write transaction, immediately
   * after the row is written, with the transcript row snapshot as of that same
   * commit. Sync callers use this to capture an atomically-consistent "expected
   * snapshot" for a later `replaceTranscriptEventsSync` — reading it back after
   * the transaction has already committed would leave a window for a foreign
   * process's append to land in between and be silently absorbed. Skipped when
   * `expectedSnapshot` is provided and no longer matches (see above).
   */
  onCommittedSnapshot?: (rows: SqliteTranscriptSnapshotRow[]) => void;
};

export type TranscriptEventAppendError =
  | {
      actualSessionId: string;
      code: "session-rebound";
      expectedSessionId: string;
      sessionKey: string;
    }
  | {
      code: "session-entry-missing";
      expectedSessionId: string;
      sessionKey: string;
    };

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

/** Raw transcript row shape used to detect a foreign process's concurrent commit. */
export type SqliteTranscriptSnapshotRow = {
  eventJson: string;
  seq: number;
};

export type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionParentForkDecision,
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
  TranscriptEvent,
} from "./session-accessor.types.js";

export type TranscriptMessageAppendOptions<TMessage> = {
  appendIntent?: "active-branch";
  config?: OpenClawConfig;
  cwd?: string;
  idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
  message: TMessage;
  now?: number;
  eventId?: string;
  parentId?: string | null;
  prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
  useRawWhenLinear?: boolean;
  /** See {@link TranscriptEventAppendOptions.expectedSnapshot}. */
  expectedSnapshot?: readonly SqliteTranscriptSnapshotRow[];
  /** See {@link TranscriptEventAppendOptions.onCommittedSnapshot}. */
  onCommittedSnapshot?: (rows: SqliteTranscriptSnapshotRow[]) => void;
};

export type TranscriptMessageAppendResult<TMessage> = {
  appended: boolean;
  anchor?: TranscriptEntryAnchor;
  effectiveParentId?: string | null;
  message: TMessage;
  messageId: string;
};

export type TranscriptUpdatePayload = Partial<SessionTranscriptUpdate>;

export type LatestTranscriptAssistantText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type LatestTranscriptAssistantMessage = {
  id?: string;
  message: unknown;
};

export type SessionTranscriptTurnMessageAppend = TranscriptMessageAppendOptions<unknown> & {
  shouldAppend?: (context: SessionTranscriptTurnWriteContext) => Promise<boolean> | boolean;
};

export type SessionTranscriptTurnWriteContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
};

export type SessionEntryPatchOptions = {
  assertCommitAllowed?: () => void;
  fallbackEntry?: SessionEntry;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  preserveActivity?: boolean;
  requireWriteSuccess?: boolean;
  replaceEntry?: boolean;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
};

export type SessionEntryPatchContext = {
  existingEntry?: SessionEntry;
};

export type SessionEntryTargetPatchScope = {
  agentId?: string;
  storePath: string;
  target: SessionLifecycleStoreTarget;
};

export type SessionEntryReplacementSnapshot = {
  entry: SessionEntry;
  sessionKey: string;
};

type SessionEntryReplacement = {
  entry: SessionEntry;
  sessionKey: string;
};

export type SessionEntryReplacementUpdate<T> = {
  replacements?: Iterable<SessionEntryReplacement>;
  result: T;
};

type SessionEntryBatchProjectionMutation = {
  entry: SessionEntry;
  previousSessionKeys?: readonly string[];
  sessionKey: string;
};

export type SessionEntryBatchProjectionUpdate<T> = {
  mutations?: Iterable<SessionEntryBatchProjectionMutation>;
  result: T;
};

export type {
  DeletedAgentSessionEntryPurgeParams,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
};
