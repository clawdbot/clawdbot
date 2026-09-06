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
} from "./session-accessor.lifecycle-types.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryStatus = NonNullable<SessionEntry["status"]>;

export type SessionTranscriptInstance = SessionEntrySummary & {
  agentId: string;
  /** Stable transcript identity, including rotated history for one logical session key. */
  sessionId: string;
  /** True when this transcript instance was owned by an ACP runtime. */
  acpOwned: boolean;
  /** True when exclusion-sensitive session ownership was captured for this transcript id. */
  provenanceKnown: boolean;
  /** Activity timestamp for this transcript instance, not the current logical session row. */
  updatedAtMs: number;
  /** Recorded source facts; coarse historical trust classes cannot identify an exact hook source. */
  sourceMetadata: {
    createdAt: number;
    channel: string | null;
    accountId: string | null;
    chatType: NonNullable<SessionEntry["chatType"]> | null;
    hookExternalContentSource: NonNullable<SessionEntry["hookExternalContentSource"]> | null;
  };
};

export type SessionTranscriptInstanceListOptions = {
  /** Include empty and internal windows when inspecting recorded source metadata. */
  includeAllWindows?: boolean;
  sessionId?: string;
};

export type TranscriptEventAppendOptions = {
  appendIntent?: "active-branch";
  /** Synchronous authority check run inside the append transaction. */
  beforeCommitInTransaction?: () => void;
};

export type TranscriptAppendRefusal =
  | {
      actualSessionIdHash: string;
      agentIdHash: string;
      code: "session-rebound";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    }
  | {
      agentIdHash: string;
      code: "session-entry-missing";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
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

export type LatestTranscriptAssistantMessage = {
  id?: string;
  message: unknown;
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

export type {
  ExactSessionEntry,
  LatestTranscriptAssistantText,
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntrySummary,
  SessionEntryTargetPatchScope,
  SessionTranscriptAccessScope,
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  SessionTranscriptStats,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
} from "./session-accessor.types.js";
