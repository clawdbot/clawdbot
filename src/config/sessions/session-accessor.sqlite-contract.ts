import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type {
  DeletedAgentSessionEntryPurgeParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleMutation,
  ResetSessionEntryLifecycleResult,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionLifecycleStoreTarget,
} from "./store.js";
import type { SessionEntry } from "./types.js";

export type SessionAccessScope = {
  agentId?: string;
  clone?: boolean;
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
  sessionEntry?: Pick<SessionEntry, "sessionFile"> & Partial<Pick<SessionEntry, "sessionId">>;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  sessionId?: string;
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

export type TranscriptEvent = unknown;

export type SessionTranscriptStats = {
  eventCount: number;
  lastMutationAtMs?: number;
  lastObservedMutationAtMs?: number;
  maxSeq: number;
  sizeBytes: number;
};

export type TranscriptMessageAppendOptions<TMessage> = {
  config?: OpenClawConfig;
  cwd?: string;
  idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
  message: TMessage;
  now?: number;
  eventId?: string;
  parentId?: string | null;
  prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
  useRawWhenLinear?: boolean;
};

export type TranscriptMessageAppendResult<TMessage> = {
  appended: boolean;
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
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
};

export type SessionEntryPatchOptions = {
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

type ParentForkedSessionTranscript = {
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

export type ResetSessionEntryLifecycleParams = {
  afterEntryMutation?: (mutation: ResetSessionEntryLifecycleMutation) => Promise<void> | void;
  agentId?: string;
  buildNextEntry: (context: {
    currentEntry?: SessionEntry;
    primaryKey: string;
  }) => Promise<SessionEntry> | SessionEntry;
  storePath: string;
  target: SessionLifecycleStoreTarget;
};

export type DeleteSessionEntryLifecycleParams = {
  agentId?: string;
  archiveTranscript: boolean;
  expectedEntry?: SessionEntry;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedUpdatedAt?: number;
  storePath: string;
  target: SessionLifecycleStoreTarget;
};

export type {
  DeletedAgentSessionEntryPurgeParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
};
