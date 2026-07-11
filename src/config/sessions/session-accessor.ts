import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockOptions,
} from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type {
  SessionTranscriptUpdate,
  SessionTranscriptUpdateTarget,
} from "../../sessions/transcript-events.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { extractGeneratedTranscriptSessionId } from "./generated-transcript-session-id.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
} from "./paths.js";
import {
  cleanupPluginHostSessionStore as cleanupFilePluginHostSessionStore,
  clearPluginOwnedSessionState,
  type PluginHostSessionCleanupStoreParams,
} from "./plugin-host-cleanup.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type {
  ResolvedSessionMaintenanceConfig,
  SessionMaintenanceWarning,
} from "./store-maintenance.js";
import {
  getSessionEntry,
  cleanupSessionLifecycleArtifacts as cleanupFileSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle as deleteFileSessionEntryLifecycle,
  applySessionEntryLifecycleMutation as applyFileSessionEntryLifecycleMutation,
  listSessionEntries as listFileSessionEntries,
  loadSessionStore,
  applySessionEntryPatchProjection as applyFileSessionEntryPatchProjection,
  patchSessionEntry as patchFileSessionEntry,
  patchSessionEntryWithKey as patchFileSessionEntryWithKey,
  purgeDeletedAgentSessionEntries as purgeFileDeletedAgentSessionEntries,
  projectSessionEntryForPersistenceRevision,
  readSessionUpdatedAt as readFileSessionUpdatedAt,
  recordSessionMetaFromInbound as recordFileSessionMetaFromInbound,
  resolveSessionStoreEntry,
  resetSessionEntryLifecycle as resetFileSessionEntryLifecycle,
  rollbackAgentHarnessSessionEntryLifecycle as rollbackFileAgentHarnessSessionEntryLifecycle,
  updateLastRoute as updateFileSessionLastRoute,
  updateSessionStore,
  updateSessionStoreEntry as updateFileSessionStoreEntry,
  type DeleteSessionEntryLifecycleResult,
  type ResetSessionEntryLifecycleMutation,
  type ResetSessionEntryLifecycleResult,
  type DeletedAgentSessionEntryPurgeParams,
  type SessionArchivedTranscriptCleanupRule,
  type SessionEntryLifecycleMutationResult,
  type SessionEntryLifecycleRemoval,
  type SessionEntryLifecycleUpsert,
  type SessionEntryPatchProjectionContext,
  type SessionEntryPatchProjectionFailure,
  type SessionEntryPatchProjectionResult,
  type SessionEntryPatchProjectionSnapshot,
  type SessionEntryPatchProjectionTarget,
  type SessionLifecycleArchivedTranscript,
  type SessionLifecycleArtifactCleanupParams,
  type SessionLifecycleArtifactCleanupResult,
  type SessionLifecycleStoreTarget,
} from "./store.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionStoreTarget } from "./targets.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import {
  type AppendSessionTranscriptMessageParams,
  type AppendSessionTranscriptMessageResult,
  appendSessionTranscriptEvent,
  appendSessionTranscriptMessage,
  appendSessionTranscriptMessageWithOwnedWriteLock,
  withSessionTranscriptAppendQueue,
} from "./transcript-append.js";
import { resolveSessionTranscriptFile } from "./transcript-file-resolve.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { serializeJsonlLine, writeJsonlLines } from "./transcript-jsonl.js";
import { replayRecentUserAssistantMessages } from "./transcript-replay.js";
import {
  streamSessionTranscriptLines,
  streamSessionTranscriptLinesReverse,
} from "./transcript-stream.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import {
  type OwnedSessionTranscriptPublishedEntry,
  resolveOwnedSessionTranscriptWriteLockRunner,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import {
  mergeSessionEntry,
  type GroupKeyResolution,
  type SessionCompactionCheckpoint,
  type SessionEntry,
} from "./types.js";

/**
 * Session access API for callers that need entries or transcripts without
 * depending on the persisted store layout. Callers provide stable session
 * identity, and this module resolves the current entry/transcript target while
 * preserving canonical-key, transcript-linking, and update-notification rules.
 *
 * Ownership contract (#88838): this accessor is the permanent storage-neutral
 * domain boundary for session/transcript runtime access; the SQLite storage
 * flip implements this interface. The entry workflow helpers in store.ts are
 * the file-backend implementation it delegates to plus the plugin-SDK
 * deprecation-window surface (RFC 0007); they become internal as direct
 * callers migrate here. New runtime callers use this module, not store.ts.
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

type SessionEntryListScope = Partial<Omit<SessionAccessScope, "sessionKey">>;

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

type ResolvedSessionEntryStoreTarget = ResolvedSessionEntryAccessTarget & {
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
  /** Explicit transcript file path; bypasses store lookup when already known. */
  sessionFile?: string;
  /** Runtime session id used to derive a transcript file when no explicit file is provided. */
  sessionId: string;
  /** Required when resolving through session metadata; optional for explicit transcript artifacts. */
  sessionKey?: string;
  /** Channel thread suffix used when deriving topic transcript paths. */
  threadId?: string | number;
};

export type SessionTranscriptRuntimeScope = SessionAccessScope & {
  /** Resolved file-backed artifact for the current runtime target. */
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
  /** Optional for appenders that can operate on an existing explicit transcript target. */
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

/** Raw transcript record for non-message events; message records use appendTranscriptMessage. */
export type TranscriptEvent = unknown;

export type TranscriptMessageAppendOptions<TMessage> = {
  /** Runtime config used for message redaction and transcript header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /** How duplicate message idempotency keys are detected before append. */
  idempotencyLookup?: "scan" | "caller-checked";
  /** Provider/channel message payload to persist. */
  message: TMessage;
  /** Testable timestamp override for the generated transcript entry. */
  now?: number;
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

/** Transcript update fields supplied by callers; sessionFile is resolved here. */
export type TranscriptUpdatePayload = Omit<SessionTranscriptUpdate, "sessionFile">;

export type SessionTranscriptTurnUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptTurnMessageAppend = TranscriptMessageAppendOptions<unknown> & {
  /**
   * Runs inside the file-backed write lock before this message is appended.
   * SQLite implementation note: duplicate/skip decisions should be evaluated
   * inside the same write transaction as the transcript row append.
   */
  shouldAppend?: (context: SessionTranscriptTurnWriteContext) => Promise<boolean> | boolean;
};

export type SessionTranscriptTurnWriteContext = {
  agentId?: string;
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
};

export type SessionTranscriptTurnPersistOptions = {
  /** Runtime config used for lock settings, redaction, and header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /**
   * Rejects the turn when the persisted session key no longer points at this
   * runtime session id. SQLite implementations must evaluate this guard inside
   * the same write transaction as the transcript append and metadata touch.
   */
  expectedSessionId?: string;
  /** Rejects the turn when lifecycle ownership changed without rotating the session id. */
  expectedLifecycleRevision?: string;
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

type SessionTranscriptTurnAppendRunner = <TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
) => Promise<AppendSessionTranscriptMessageResult<TMessage> | undefined>;

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

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../../gateway/session-archive.runtime.js"),
);

// Fork-source reading parses legacy transcript versions through the agents
// session-manager; load it lazily so accessor consumers do not pull that
// runtime (and its module-init package metadata reads) at import time.
const loadSessionForkTranscriptRuntime = createLazyRuntimeModule(
  () => import("./session-fork-transcript.runtime.js"),
);

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

/** Result of applying a checkpoint branch or restore mutation to session storage. */
export type SessionCompactionCheckpointMutationResult =
  | {
      status: "created";
      key: string;
      checkpoint: SessionCompactionCheckpoint;
      entry: SessionEntry;
    }
  | { status: "missing-session" }
  | { status: "model-selection-locked" }
  | { status: "missing-checkpoint" }
  | { status: "missing-boundary" }
  | { status: "failed" };

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

type TemporarySessionMappingSnapshot =
  | {
      canRestore: false;
      sessionKey: string;
      snapshotFailure: string;
      storePath: string;
    }
  | {
      canRestore: true;
      hadEntry: false;
      sessionKey: string;
      storePath: string;
    }
  | {
      canRestore: true;
      entry: SessionEntry;
      hadEntry: true;
      sessionKey: string;
      storePath: string;
    };

type TemporarySessionMappingOperationResult<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      error: unknown;
      ok: false;
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
  /** Protect the newly created row from maintenance during its initial save. */
  activeSessionKey?: string;
  /** Throw unless the initial session row is durably persisted. */
  requireWriteSuccess?: boolean;
};

type CreatedSessionTranscriptResult =
  | { ok: true; created: boolean; sessionFile: string }
  | { ok: false; error: string; phase: "transcript" };

export type SessionPatchProjectionContext = SessionEntryPatchProjectionContext;
export type SessionPatchProjectionFailure = SessionEntryPatchProjectionFailure;
export type SessionPatchProjectionResult<TFailure extends SessionPatchProjectionFailure> =
  SessionEntryPatchProjectionResult<TFailure>;
export type SessionPatchProjectionSnapshot = SessionEntryPatchProjectionSnapshot;
export type SessionPatchProjectionTarget = SessionEntryPatchProjectionTarget;

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
  /** Runs after the persisted entry rotates and before transcript artifacts move. */
  afterEntryMutation?: (mutation: ResetSessionEntryLifecycleMutation) => Promise<void> | void;
  /** Agent owner used to resolve backend transcript artifacts. */
  agentId?: string;
  /** Builds the persisted replacement entry from the current backend row. */
  buildNextEntry: (context: {
    currentEntry?: SessionEntry;
    primaryKey: string;
  }) => Promise<SessionEntry> | SessionEntry;
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
  /** Optional exact row guard checked under the storage writer lock. */
  expectedEntry?: SessionEntry;
  /** Optional provider-run identity guard checked under the storage writer lock. */
  expectedSessionId?: string;
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

export { clearPluginOwnedSessionState };

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function resolveLogicalSessionStoreCandidates(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[] {
  const storeConfig = params.cfg.session?.store;
  const defaultTarget = {
    agentId: params.agentId,
    storePath: resolveStorePath(storeConfig, { agentId: params.agentId, env: params.env }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    if (target.agentId === params.agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function buildLogicalSessionEntryCandidateKeys(params: {
  agentId: string;
  canonicalKey: string;
  cfg: OpenClawConfig;
  requestedKey: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.requestedKey && params.requestedKey !== params.canonicalKey) {
    targets.add(params.requestedKey);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function findFreshestSessionEntryMatch(
  entries: SessionEntrySummary[],
  candidateKeys: readonly string[],
): SessionEntrySummary | undefined {
  let freshest: SessionEntrySummary | undefined;
  for (const candidate of candidateKeys) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const match = entries.find((entry) => entry.sessionKey === trimmed);
    if (match && (!freshest || (match.entry.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) {
      freshest = match;
    }
  }
  return freshest;
}

/**
 * Resolves a logical session key to the freshest matching entry across the
 * configured store and discovered same-agent stores.
 */
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryAccessTarget {
  const target = resolveSessionEntryStoreTarget(scope);
  return {
    agentId: target.agentId,
    canonicalKey: target.canonicalKey,
    entry: target.entry,
    requestedKey: target.requestedKey,
    storeKey: target.storeKey,
  };
}

/** Resolves ordered candidate keys inside one agent-owned session store. */
export function resolveSessionEntryCandidateTarget(
  scope: SessionEntryCandidateAccessScope,
): ResolvedSessionEntryCandidateTarget | null {
  const storePath = resolveStorePath(scope.cfg.session?.store, {
    agentId: scope.agentId,
    env: scope.env,
  });
  const store = loadSessionStore(storePath);
  for (const candidateKey of uniqueStrings(scope.candidateKeys.map((key) => key.trim()))) {
    if (!candidateKey) {
      continue;
    }
    const resolved = resolveSessionStoreEntry({ store, sessionKey: candidateKey });
    if (!resolved.existing) {
      continue;
    }
    return {
      agentId: scope.agentId,
      candidateKey,
      entry: structuredClone(resolved.existing),
      persisted: true,
      sessionKey: resolved.normalizedKey,
    };
  }
  const fallbackKey = scope.fallback?.sessionKey.trim();
  if (!fallbackKey || !scope.fallback) {
    return null;
  }
  return {
    agentId: scope.agentId,
    candidateKey: fallbackKey,
    entry: structuredClone(scope.fallback.entry),
    persisted: false,
    sessionKey: fallbackKey,
  };
}

function resolveSessionEntryStoreTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryStoreTarget {
  const requestedKey = scope.sessionKey.trim();
  const canonicalKey = resolveSessionStoreKey({ cfg: scope.cfg, sessionKey: requestedKey });
  const agentId = resolveSessionStoreAgentId(scope.cfg, canonicalKey);
  const scanTargets = buildLogicalSessionEntryCandidateKeys({
    agentId,
    canonicalKey,
    cfg: scope.cfg,
    requestedKey,
  });
  const candidates = resolveLogicalSessionStoreCandidates({
    agentId,
    cfg: scope.cfg,
    env: scope.env,
  });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveStorePath(scope.cfg.session?.store, { agentId, env: scope.env }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch = findFreshestSessionEntryMatch(
    listSessionEntries({ storePath: fallback.storePath }),
    scanTargets,
  );
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const match = findFreshestSessionEntryMatch(
      listSessionEntries({ storePath: candidate.storePath }),
      scanTargets,
    );
    if (
      match &&
      (!selectedMatch || (match.entry.updatedAt ?? 0) >= (selectedMatch.entry.updatedAt ?? 0))
    ) {
      selectedStorePath = candidate.storePath;
      selectedMatch = match;
    }
  }
  return {
    agentId,
    canonicalKey,
    entry: selectedMatch?.entry,
    requestedKey,
    storeKey: selectedMatch?.sessionKey ?? canonicalKey,
    storePath: selectedStorePath,
  };
}

/**
 * Mutates the freshest matching logical session entry without exposing the
 * backing store map to callers.
 */
export async function updateResolvedSessionEntry<T>(
  scope: LogicalSessionAccessScope,
  update: (entry: SessionEntry, context: ResolvedSessionEntryUpdateContext) => Promise<T> | T,
): Promise<ResolvedSessionEntryUpdateResult<T>> {
  const target = resolveSessionEntryStoreTarget(scope);
  if (!target.entry) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  return await updateSessionStore(target.storePath, async (store) => {
    const entry = store[target.storeKey];
    if (!entry) {
      return { canonicalKey: target.canonicalKey, found: false };
    }
    const context: ResolvedSessionEntryUpdateContext = {
      agentId: target.agentId,
      canonicalKey: target.canonicalKey,
      entry,
      requestedKey: target.requestedKey,
      storeKey: target.storeKey,
    };
    const result = await update(entry, context);
    return {
      canonicalKey: target.canonicalKey,
      entry: structuredClone(entry),
      found: true,
      result,
      storeKey: target.storeKey,
    };
  });
}

/** Returns the entry for a canonical or alias session key, if one exists. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  if (scope.clone === false || scope.readConsistency === "latest") {
    const store = loadSessionStore(resolveSessionStorePathForScope(scope), {
      ...(scope.clone === false ? { clone: false } : {}),
      ...(scope.readConsistency === "latest" ? { skipCache: true } : {}),
      ...(scope.hydrateSkillPromptRefs === false ? { hydrateSkillPromptRefs: false } : {}),
    });
    return resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey }).existing;
  }
  return getSessionEntry(scope);
}

/** Lists entries from the resolved store, preserving the persisted key for each row. */
export function listSessionEntries(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  if (scope.clone === false) {
    return openSessionEntryReadView(scope).entries();
  }
  return listFileSessionEntries(scope);
}

/**
 * Borrowed keyed view over one resolved store for synchronous read-only hot paths.
 * Unlike loadSessionEntry, `get` is a raw exact persisted-key probe with no alias
 * or canonical-key resolution and no row scans, so large stores stay cheap until
 * `entries` is called. Rows are borrowed, not cloned: callers must not mutate them
 * and must drop the view before any await.
 */
export function openSessionEntryReadView(
  scope: Omit<SessionEntryListScope, "clone" | "readConsistency"> = {},
): SessionEntryReadView {
  const store = loadSessionStore(resolveSessionStorePathForScope({ ...scope, sessionKey: "" }), {
    clone: false,
    ...(scope.hydrateSkillPromptRefs === false ? { hydrateSkillPromptRefs: false } : {}),
  });
  return {
    get: (sessionKey) => (Object.hasOwn(store, sessionKey) ? store[sessionKey] : undefined),
    entries: () => Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  };
}

/** Reads the last activity timestamp for one session entry, or undefined when absent. */
export function readSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  if (scope.storePath) {
    return readFileSessionUpdatedAt({
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
    });
  }
  return loadSessionEntry(scope)?.updatedAt;
}

/** Creates or updates one entry from a partial patch and returns the persisted entry. */
export async function upsertSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await patchFileSessionEntry({
    ...scope,
    fallbackEntry: createFallbackSessionEntry(patch),
    update: () => patch,
  });
}

/** Replaces one entry with the supplied value and returns the persisted entry. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchFileSessionEntry({
    ...scope,
    fallbackEntry: entry,
    replaceEntry: true,
    update: () => entry,
  });
}

/**
 * Applies an atomic patch to one entry.
 * The updater sees the current entry plus whether it was synthesized from a
 * fallback; returning null skips persistence.
 */
export async function patchSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchFileSessionEntry({
    ...scope,
    fallbackEntry: options.fallbackEntry,
    maintenanceConfig: options.maintenanceConfig,
    preserveActivity: options.preserveActivity,
    requireWriteSuccess: options.requireWriteSuccess,
    replaceEntry: options.replaceEntry,
    skipMaintenance: options.skipMaintenance,
    takeCacheOwnership: options.takeCacheOwnership,
    update,
  });
}

/**
 * Applies an atomic patch and returns the persisted key selected by the backing
 * store. Use when a caller must keep sidecar state keyed to the final row.
 */
export async function patchSessionEntryWithKey(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntryPatchResult | null> {
  return await patchFileSessionEntryWithKey({
    ...scope,
    fallbackEntry: options.fallbackEntry,
    maintenanceConfig: options.maintenanceConfig,
    preserveActivity: options.preserveActivity,
    requireWriteSuccess: options.requireWriteSuccess,
    replaceEntry: options.replaceEntry,
    skipMaintenance: options.skipMaintenance,
    takeCacheOwnership: options.takeCacheOwnership,
    update,
  });
}

/**
 * Promotes the freshest alias row to the canonical key, prunes legacy aliases,
 * and optionally patches the canonical entry under one accessor operation.
 */
export async function canonicalizeSessionEntryAliases(params: {
  storePath: string;
  target: SessionLifecycleStoreTarget;
  update?: (
    entry: SessionEntry | undefined,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
}): Promise<CanonicalizeSessionEntryAliasesResult> {
  return await updateSessionStore(params.storePath, async (store) => {
    const targetKeys = normalizeTargetStoreKeys(params.target);
    const freshest = resolveFreshestTargetEntry(store, targetKeys);
    if (freshest) {
      const current = store[params.target.canonicalKey];
      if (!current || (freshest.entry.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
        store[params.target.canonicalKey] = freshest.entry;
      }
    }

    const currentEntry = store[params.target.canonicalKey];
    const patch = params.update ? await params.update(cloneOptionalEntry(currentEntry)) : null;
    if (patch) {
      store[params.target.canonicalKey] = {
        ...currentEntry,
        ...patch,
      } as SessionEntry;
    }

    for (const key of targetKeys) {
      if (key !== params.target.canonicalKey) {
        delete store[key];
      }
    }
    const entry = cloneOptionalEntry(store[params.target.canonicalKey]);
    return {
      canonicalKey: params.target.canonicalKey,
      ...(entry ? { entry } : {}),
    };
  });
}

// Normalizes caller-supplied alias sets while always preserving the canonical key.
function normalizeTargetStoreKeys(target: SessionLifecycleStoreTarget): string[] {
  const keys = new Set<string>();
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  };
  remember(target.canonicalKey);
  for (const key of target.storeKeys) {
    remember(key);
  }
  return [...keys];
}

// Selects the row that current JSON-store alias migration would promote.
function resolveFreshestTargetEntry(
  store: Record<string, SessionEntry>,
  targetKeys: readonly string[],
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of targetKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    if (!freshest || (entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = { key, entry };
    }
  }
  return freshest;
}

function cloneOptionalEntry(entry: SessionEntry | undefined): SessionEntry | undefined {
  return entry ? structuredClone(entry) : undefined;
}

/**
 * Creates or updates one session entry and initializes its transcript header as
 * one storage-sized lifecycle operation. File-backed storage still writes JSON
 * plus JSONL, but callers no longer compose entry write, header creation,
 * rollback, and normalized sessionFile persistence themselves.
 */
export async function createSessionEntryWithTranscript<TError = string>(
  scope: SessionAccessScope,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions = {},
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const storePath = resolveSessionStorePathForScope(scope);
  let createdTranscriptFile: string | undefined;
  try {
    return await updateSessionStore(
      storePath,
      async (store) => {
        const resolved = resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey });
        const created = await createEntry({
          existingEntry: resolved.existing ? { ...resolved.existing } : undefined,
          sessionEntries: cloneSessionEntries(store),
        });
        if (!created.ok) {
          return { ok: false, error: created.error, phase: "entry" };
        }

        const ensured = ensureCreatedSessionTranscript({
          agentId: scope.agentId,
          entry: created.entry,
          storePath,
        });
        if (!ensured.ok) {
          delete store[resolved.normalizedKey];
          return ensured;
        }
        if (ensured.created) {
          createdTranscriptFile = ensured.sessionFile;
        }

        const entry =
          created.entry.sessionFile === ensured.sessionFile
            ? created.entry
            : {
                ...created.entry,
                sessionFile: ensured.sessionFile,
              };
        store[resolved.normalizedKey] = entry;
        for (const legacyKey of resolved.legacyKeys) {
          delete store[legacyKey];
        }
        return { ok: true, entry, sessionFile: ensured.sessionFile };
      },
      {
        activeSessionKey: options.activeSessionKey,
        requireWriteSuccess: options.requireWriteSuccess,
        // Entry rejection is side-effect free; transcript failure deletes the target row
        // and must persist that rollback instead of restoring the writer snapshot.
        skipSaveWhenResult: (result) => !result.ok && result.phase === "entry",
      },
    );
  } catch (error) {
    if (!createdTranscriptFile) {
      throw error;
    }
    try {
      fs.rmSync(createdTranscriptFile, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `Session entry persistence failed (${formatErrorMessage(error)}) and transcript cleanup did not complete: ${createdTranscriptFile}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

function cloneSessionEntries(store: Record<string, SessionEntry>): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [sessionKey, { ...entry }]),
  );
}

function collectSessionEntryKeys(...entries: SessionEntry[]): Array<keyof SessionEntry> {
  const keys = new Set<keyof SessionEntry>();
  for (const entry of entries) {
    for (const key of Object.keys(entry) as Array<keyof SessionEntry>) {
      keys.add(key);
    }
  }
  return [...keys];
}

function sessionEntryFieldEqual(
  left: SessionEntry[keyof SessionEntry],
  right: SessionEntry[keyof SessionEntry],
): boolean {
  return Object.is(left, right) || isDeepStrictEqual(left, right);
}

function sessionEntryFieldUnset(
  hasValue: boolean,
  value: SessionEntry[keyof SessionEntry],
): boolean {
  return !hasValue || value === undefined;
}

function sessionEntryFieldUnchanged(params: {
  leftHasValue: boolean;
  leftValue: SessionEntry[keyof SessionEntry];
  rightHasValue: boolean;
  rightValue: SessionEntry[keyof SessionEntry];
}): boolean {
  const { leftHasValue, leftValue, rightHasValue, rightValue } = params;
  if (
    sessionEntryFieldUnset(leftHasValue, leftValue) &&
    sessionEntryFieldUnset(rightHasValue, rightValue)
  ) {
    return true;
  }
  return leftHasValue === rightHasValue && sessionEntryFieldEqual(leftValue, rightValue);
}

// Background activity can mutate non-identity fields after the initialization
// snapshot. Carry forward only same-session changes; the prepared entry still
// wins for any field it explicitly modified relative to the snapshot. This
// preserves heartbeat/delivery/context metadata without resurrecting fields that
// a reset intentionally cleared or carrying old-session metadata into /new.
function mergeConcurrentReplySessionMetadata(params: {
  currentEntry: SessionEntry;
  preparedEntry: SessionEntry;
  snapshotEntry?: SessionEntry;
}): SessionEntry {
  const { currentEntry, preparedEntry, snapshotEntry } = params;
  if (!snapshotEntry || preparedEntry.sessionId !== snapshotEntry.sessionId) {
    return preparedEntry;
  }
  const merged: SessionEntry = { ...preparedEntry };
  const mergedFields = merged as Partial<
    Record<keyof SessionEntry, SessionEntry[keyof SessionEntry]>
  >;
  for (const key of collectSessionEntryKeys(currentEntry, preparedEntry, snapshotEntry)) {
    const currentHasValue = Object.hasOwn(currentEntry, key);
    const snapshotHasValue = Object.hasOwn(snapshotEntry, key);
    const preparedHasValue = Object.hasOwn(preparedEntry, key);
    const currentValue = currentEntry[key];
    const snapshotValue = snapshotEntry[key];
    const preparedValue = preparedEntry[key];
    const currentChanged = !sessionEntryFieldUnchanged({
      leftHasValue: currentHasValue,
      leftValue: currentValue,
      rightHasValue: snapshotHasValue,
      rightValue: snapshotValue,
    });
    const preparedKeptSnapshot = sessionEntryFieldUnchanged({
      leftHasValue: preparedHasValue,
      leftValue: preparedValue,
      rightHasValue: snapshotHasValue,
      rightValue: snapshotValue,
    });
    if (currentChanged && preparedKeptSnapshot) {
      if (currentHasValue) {
        mergedFields[key] = currentValue;
      } else {
        delete mergedFields[key];
      }
    }
  }
  return merged;
}

function createReplySessionInitializationRevision(params: {
  entry: SessionEntry | undefined;
  storePath: string;
}): string {
  const { entry, storePath } = params;
  if (!entry) {
    return JSON.stringify(null);
  }
  // The guard only rejects a true session-identity rebind. Same-session
  // activity/context writes are merged below; comparing them here would reject
  // before the merge can preserve the concurrent metadata.
  const projected = projectSessionEntryForPersistenceRevision({ storePath, entry });
  const revisionEntry: Pick<SessionEntry, "sessionFile" | "sessionId"> = {
    sessionId: projected.sessionId,
  };
  if (projected.sessionFile !== undefined) {
    revisionEntry.sessionFile = projected.sessionFile;
  }
  return JSON.stringify(revisionEntry);
}

function resolveInitializedReplySessionEntry(params: {
  agentId: string;
  currentEntry?: SessionEntry;
  fallbackSessionFile?: string;
  sessionEntry: SessionEntry;
  storePath: string;
}): SessionEntry {
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const currentSessionFile = params.currentEntry?.sessionFile;
  const inheritedPreviousSessionFile =
    Boolean(currentSessionFile) &&
    params.currentEntry?.sessionId !== params.sessionEntry.sessionId &&
    currentSessionFile === params.sessionEntry.sessionFile;
  const entryForResolve =
    fallbackSessionFile && (inheritedPreviousSessionFile || !params.sessionEntry.sessionFile)
      ? { ...params.sessionEntry, sessionFile: fallbackSessionFile }
      : inheritedPreviousSessionFile
        ? { ...params.sessionEntry, sessionFile: undefined }
        : params.sessionEntry;
  const sessionFile = resolveSessionFilePath(params.sessionEntry.sessionId, entryForResolve, {
    agentId: params.agentId,
    sessionsDir: path.dirname(path.resolve(params.storePath)),
  });
  return {
    ...params.sessionEntry,
    sessionFile,
  };
}

// File-backed creation resolves the concrete transcript artifact and writes the
// header before the store mutation is saved; SQLite adapters implement this as
// the same lifecycle operation without exposing rollback details to callers.
function ensureCreatedSessionTranscript(params: {
  agentId?: string;
  entry: SessionEntry;
  storePath: string;
}): CreatedSessionTranscriptResult {
  try {
    const sessionFile = resolveSessionFilePath(
      params.entry.sessionId,
      params.entry.sessionFile ? { sessionFile: params.entry.sessionFile } : undefined,
      {
        agentId: params.agentId,
        sessionsDir: path.dirname(path.resolve(params.storePath)),
      },
    );
    const created = !fs.existsSync(sessionFile);
    if (created) {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        `${JSON.stringify(createSessionTranscriptHeader({ sessionId: params.entry.sessionId }))}\n`,
        {
          encoding: "utf-8",
          mode: 0o600,
        },
      );
    }
    return { ok: true, created, sessionFile };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
      phase: "transcript",
    };
  }
}

/** Fork target identity generated by createForkedSessionTranscript. */
export type ForkedSessionTranscriptTarget = {
  sessionFile: string;
  sessionId: string;
};

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

/** Transcript identity created for a child fork. */
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
  /** Cross-agent forks land the child transcript beside the child's store. */
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
  /**
   * File-era seam: token counting for the fork decision still reads transcript
   * tails through gateway helpers, so the caller supplies the decision. The
   * SQLite flip resolves the decision inside the storage boundary instead.
   */
  resolveDecision: (parentEntry: SessionEntry) => Promise<SessionParentForkDecision>;
  sessionTarget: SessionLifecycleStoreTarget;
  skipForkWhen?: (entry: SessionEntry) => boolean;
  skipPatch?: (entry: SessionEntry) => Partial<SessionEntry> | null;
  storePath: string;
};

export type CreateForkedSessionTranscriptParams = {
  /** Working directory recorded in the forked transcript header. */
  cwd: string;
  /** Source transcript recorded as the fork's parentSession lineage. */
  parentSessionFile: string;
  /** Directory that owns the forked transcript artifact. */
  sessionsDir: string;
  /**
   * Builds the non-header records copied into the fork, in transcript order.
   * Receives the generated fork identity so records can share its timestamp.
   */
  buildEntries?: (fork: { sessionId: string; timestamp: string }) => readonly unknown[];
};

/**
 * Creates a forked transcript artifact under a fresh session id as one storage
 * operation. File-backed storage writes header plus copied records as a new
 * JSONL artifact; SQLite implements the same fork as transcript row copies
 * inside one write transaction (#88838).
 */
export async function createForkedSessionTranscript(
  params: CreateForkedSessionTranscriptParams,
): Promise<ForkedSessionTranscriptTarget> {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  // Fork artifacts keep the timestamp-prefixed file name so sibling transcripts
  // in one sessions dir sort by creation time.
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(params.sessionsDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header = createSessionTranscriptHeader({
    sessionId,
    cwd: params.cwd,
    parentSession: params.parentSessionFile,
    timestamp,
  });
  const entries = params.buildEntries?.({ sessionId, timestamp }) ?? [];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  // "wx" keeps create-only semantics: a fork must never clobber an existing transcript.
  await writeJsonlLines(sessionFile, [header, ...entries].map(serializeJsonlLine), {
    flag: "wx",
    mode: 0o600,
  });
  return { sessionFile, sessionId };
}

/**
 * Forks the active branch of a parent transcript into a fresh child transcript.
 * This is for guarded callers that already own the eventual entry commit.
 */
export async function forkSessionFromParentTranscript(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  let parentSessionFile: string;
  try {
    parentSessionFile = resolveSessionFilePath(
      params.parentEntry.sessionId,
      params.parentEntry,
      resolveSessionFilePathOptions({
        ...(params.agentId ? { agentId: params.agentId } : {}),
        storePath: params.storePath,
      }),
    );
  } catch {
    return { status: "missing-parent" };
  }
  if (!parentSessionFile) {
    return { status: "missing-parent" };
  }
  try {
    const { buildForkedBranchEntries, forkSourceHasAssistantEntry, readForkSourceTranscript } =
      await loadSessionForkTranscriptRuntime();
    const source = await readForkSourceTranscript(parentSessionFile);
    if (!source) {
      return { status: "failed" };
    }
    const shouldPersistBranch =
      source.preserveLeafControl || forkSourceHasAssistantEntry(source.branchEntries);
    // Cross-agent forks land beside the child's store; same-store forks stay
    // beside the parent transcript so sibling artifacts sort together.
    const targetSessionsDir = params.targetStorePath
      ? path.dirname(params.targetStorePath)
      : source.sessionDir;
    const transcript = shouldPersistBranch
      ? await createForkedSessionTranscript({
          cwd: source.cwd,
          parentSessionFile,
          sessionsDir: targetSessionsDir,
          buildEntries: ({ timestamp }) => buildForkedBranchEntries({ source, timestamp }),
        })
      : // Header-only fork: nothing on the active branch is worth copying.
        await createForkedSessionTranscript({
          cwd: source.cwd,
          parentSessionFile,
          sessionsDir: targetSessionsDir,
        });
    return { status: "created", transcript };
  } catch {
    return { status: "failed" };
  }
}

function resolveEntryFromStoreKeys(params: {
  store: Record<string, SessionEntry>;
  keys: readonly string[];
}): SessionEntry | undefined {
  // Alias migration can leave multiple logical rows. Fork policy must inspect
  // the freshest row or a stale canonical entry can shadow a newer lock.
  return resolveFreshestTargetEntry(params.store, params.keys)?.entry;
}

function persistForkedSessionEntry(params: {
  store: Record<string, SessionEntry>;
  target: SessionLifecycleStoreTarget;
  existing: SessionEntry;
  patch: Partial<SessionEntry>;
}): SessionEntry {
  const next = mergeSessionEntry(params.existing, params.patch);
  params.store[params.target.canonicalKey] = next;
  // Alias rows collapse onto the canonical key so the forked identity has one owner row.
  for (const key of params.target.storeKeys) {
    if (key !== params.target.canonicalKey) {
      delete params.store[key];
    }
  }
  return next;
}

/**
 * Forks parent transcript content and persists the child entry/alias cleanup in
 * one storage-owned operation.
 */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  return await updateSessionStore(
    params.storePath,
    async (store) => {
      const parentEntry = resolveEntryFromStoreKeys({
        store,
        keys: params.parentTarget.storeKeys,
      });
      if (!parentEntry?.sessionId) {
        return { status: "missing-parent" };
      }

      const entry =
        resolveEntryFromStoreKeys({ store, keys: params.sessionTarget.storeKeys }) ??
        params.fallbackEntry;
      if (!entry) {
        return { status: "missing-entry" };
      }

      if (params.skipForkWhen?.(entry)) {
        const patch = params.skipPatch?.(entry);
        const sessionEntry = patch
          ? persistForkedSessionEntry({
              store,
              target: params.sessionTarget,
              existing: entry,
              patch,
            })
          : entry;
        return { status: "skipped", reason: "existing-entry", parentEntry, sessionEntry };
      }

      const decision = await params.resolveDecision(parentEntry);
      if (decision.status === "skip") {
        const patch = params.decisionSkipPatch?.({ decision, entry, parentEntry });
        const sessionEntry = patch
          ? persistForkedSessionEntry({
              store,
              target: params.sessionTarget,
              existing: entry,
              patch,
            })
          : entry;
        return {
          status: "skipped",
          reason: "decision-skip",
          parentEntry,
          sessionEntry,
          decision,
        };
      }

      const forked = await forkSessionFromParentTranscript({
        ...(params.agentId ? { agentId: params.agentId } : {}),
        parentEntry,
        parentSessionKey: params.parentTarget.canonicalKey,
        sessionKey: params.sessionTarget.canonicalKey,
        storePath: params.storePath,
      });
      if (forked.status !== "created") {
        return { status: "failed" };
      }
      const fork = forked.transcript;
      const sessionEntry = persistForkedSessionEntry({
        store,
        target: params.sessionTarget,
        existing: entry,
        patch: {
          ...params.patch?.({ entry, parentEntry, fork, decision }),
          sessionId: fork.sessionId,
          sessionFile: fork.sessionFile,
          forkedFromParent: true,
        },
      });
      return {
        status: "forked",
        fork,
        parentEntry,
        sessionEntry,
        decision,
      };
    },
    {
      skipSaveWhenResult: (result) =>
        result.status === "missing-entry" ||
        result.status === "missing-parent" ||
        result.status === "failed" ||
        (result.status === "skipped" && result.sessionEntry === params.fallbackEntry),
    },
  );
}

/** Updates an existing entry only; returns null when the session is absent. */
export async function updateSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  return await updateFileSessionStoreEntry({
    storePath: resolveSessionStorePathForScope(scope),
    sessionKey: scope.sessionKey,
    skipMaintenance: options.skipMaintenance,
    takeCacheOwnership: options.takeCacheOwnership,
    requireWriteSuccess: options.requireWriteSuccess,
    update,
  });
}

export type RecordInboundSessionMetaParams = {
  /** Set false to only patch existing entries; missing sessions stay absent. */
  createIfMissing?: boolean;
  /** Inbound message context whose stable metadata is derived and persisted. */
  ctx: MsgContext;
  /** Group routing resolution for group-owned session keys. */
  groupResolution?: GroupKeyResolution | null;
  /** Canonical or alias session key for the inbound conversation. */
  sessionKey: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type UpdateSessionLastRouteParams = {
  /** Account owning the delivery route when the channel is multi-account. */
  accountId?: string;
  /** Delivery channel id persisted as the last route channel. */
  channel?: SessionEntry["lastChannel"];
  /** Set false to only patch existing entries; missing sessions stay absent. */
  createIfMissing?: boolean;
  /** Optional inbound context whose session metadata is derived alongside the route. */
  ctx?: MsgContext;
  /** Explicit delivery context merged over the persisted session fallback. */
  deliveryContext?: DeliveryContext;
  /** Group routing resolution for group-owned session keys. */
  groupResolution?: GroupKeyResolution | null;
  /** Canonical channel route persisted as the session route slot. */
  route?: SessionEntry["route"];
  /** Canonical or alias session key for the routed conversation. */
  sessionKey: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Thread/topic id for the delivery route, when the transport has one. */
  threadId?: string | number;
  /** Delivery target persisted as the last route recipient. */
  to?: string;
};

/**
 * Records stable conversation metadata derived from one inbound message as a
 * single storage-sized upsert (createIfMissing by default). Inbound metadata
 * must not refresh activity timestamps — idle reset relies on updatedAt from
 * real session turns — so existing rows merge with preserve-activity
 * semantics while legacy alias keys collapse onto the canonical row.
 */
export async function recordInboundSessionMeta(
  params: RecordInboundSessionMetaParams,
): Promise<SessionEntry | null> {
  return await recordFileSessionMetaFromInbound(params);
}

/**
 * Persists the last known delivery route for one session as a single
 * storage-sized patch. Route updates preserve activity timestamps (#49515)
 * and merge explicit route/delivery input over the persisted session
 * fallback before normalizing the derived last* fields.
 */
export async function updateSessionLastRoute(
  params: UpdateSessionLastRouteParams,
): Promise<SessionEntry | null> {
  return await updateFileSessionLastRoute(params);
}

/** Resolves one abort target identity without exposing the mutable store. */
export function resolveSessionAbortTarget(
  scope: SessionAccessScope,
): SessionAbortTargetIdentity | null {
  const store = loadSessionStore(resolveSessionStorePathForScope(scope));
  const resolved = resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey });
  if (!resolved.existing) {
    return null;
  }
  return {
    entry: { ...resolved.existing },
    sessionId: resolved.existing.sessionId,
    sessionKey: resolved.normalizedKey,
  };
}

/**
 * Resolves, marks, touches, and canonicalizes one abort target entry as a
 * storage-sized operation. Runtime abort side effects remain with callers.
 */
export async function markSessionAbortTarget(params: {
  resolveAbortCutoff?: (context: SessionAbortTargetContext) => SessionAbortTargetCutoff | undefined;
  scope: SessionAccessScope;
  now?: () => number;
}): Promise<SessionAbortTargetResult | null> {
  const storePath = resolveSessionStorePathForScope(params.scope);
  let canPersistSingleEntry = false;
  let resolvedTarget: SessionAbortTargetResult | null = null;
  try {
    return await updateSessionStore(
      storePath,
      (store) => {
        const resolved = resolveSessionStoreEntry({
          store,
          sessionKey: params.scope.sessionKey,
        });
        if (!resolved.existing) {
          return null;
        }
        const sessionKey = resolved.normalizedKey;
        resolvedTarget = {
          entry: { ...resolved.existing },
          persisted: false,
          sessionId: resolved.existing.sessionId,
          sessionKey,
        };
        const entry = {
          ...resolved.existing,
          abortedLastRun: true,
          updatedAt: params.now?.() ?? Date.now(),
        };
        applySessionAbortCutoff(
          entry,
          params.resolveAbortCutoff?.({
            entry: { ...resolved.existing },
            sessionKey,
          }),
        );
        store[sessionKey] = entry;
        canPersistSingleEntry = resolved.legacyKeys.length === 0;
        for (const legacyKey of resolved.legacyKeys) {
          if (legacyKey !== sessionKey) {
            delete store[legacyKey];
          }
        }
        return {
          entry: { ...entry },
          persisted: true,
          sessionId: entry.sessionId,
          sessionKey,
        };
      },
      {
        resolveSingleEntryPersistence: (result) =>
          result && result.sessionKey && canPersistSingleEntry
            ? { sessionKey: result.sessionKey, entry: result.entry }
            : null,
        skipSaveWhenResult: (result) => result === null,
      },
    );
  } catch (error) {
    const fallbackTarget = resolvedTarget as unknown as SessionAbortTargetResult | null;
    if (fallbackTarget) {
      return {
        entry: fallbackTarget.entry,
        persisted: fallbackTarget.persisted,
        sessionId: fallbackTarget.sessionId,
        sessionKey: fallbackTarget.sessionKey,
        persistenceError: formatErrorMessage(error),
      };
    }
    throw error;
  }
}

function applySessionAbortCutoff(
  entry: Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">,
  cutoff: SessionAbortTargetCutoff | undefined,
): void {
  entry.abortCutoffMessageSid = cutoff?.messageSid;
  entry.abortCutoffTimestamp = cutoff?.timestamp;
}

function findSessionCompactionCheckpoint(params: {
  checkpointId: string;
  entry: SessionEntry;
}): SessionCompactionCheckpoint | undefined {
  const checkpointId = params.checkpointId.trim();
  if (!checkpointId || !Array.isArray(params.entry.compactionCheckpoints)) {
    return undefined;
  }
  let newest: SessionCompactionCheckpoint | undefined;
  for (const checkpoint of params.entry.compactionCheckpoints) {
    if (checkpoint.checkpointId !== checkpointId) {
      continue;
    }
    if (!newest || checkpoint.createdAt > newest.createdAt) {
      newest = checkpoint;
    }
  }
  return newest;
}

type ApplySessionCompactionCheckpointMutationParams = {
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  checkpointId: string;
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  readKey: string;
  storePath: string;
  writeKey: string;
};

async function applySessionCompactionCheckpointMutation(
  params: ApplySessionCompactionCheckpointMutationParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await updateSessionStore(
    params.storePath,
    async (store) => {
      const currentEntry = store[params.readKey];
      if (!currentEntry?.sessionId) {
        return { status: "missing-session" };
      }
      // A native harness owns the locked transcript identity. Rotating or
      // cloning it here would strand that binding on the old session id.
      if (currentEntry.modelSelectionLocked === true) {
        return { status: "model-selection-locked" };
      }
      const checkpoint = findSessionCompactionCheckpoint({
        entry: currentEntry,
        checkpointId: params.checkpointId,
      });
      if (!checkpoint) {
        return { status: "missing-checkpoint" };
      }
      const forkedSession = await params.forkTranscriptFromCheckpoint(checkpoint);
      if (forkedSession.status !== "created") {
        return forkedSession;
      }

      const nextEntry = await params.buildEntry({
        checkpoint,
        currentEntry,
        forkedTranscript: forkedSession.transcript,
      });
      store[params.writeKey] = nextEntry;
      return {
        status: "created",
        key: params.writeKey,
        checkpoint,
        entry: nextEntry,
      };
    },
    { skipSaveWhenResult: (result) => result.status !== "created" },
  );
}

/**
 * Forks checkpoint transcript content and persists a new branch entry in one
 * storage-sized mutation. SQLite adapters implement the transcript row copy
 * and `session_entries.entry_json` insert inside the same write transaction.
 */
export async function branchSessionFromCompactionCheckpoint(
  params: BranchSessionFromCompactionCheckpointParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await applySessionCompactionCheckpointMutation({
    buildEntry: params.buildEntry,
    checkpointId: params.checkpointId,
    forkTranscriptFromCheckpoint: params.forkTranscriptFromCheckpoint,
    readKey: params.sourceStoreKey ?? params.sourceKey,
    storePath: params.storePath,
    writeKey: params.nextKey,
  });
}

/**
 * Forks checkpoint transcript content and replaces the current entry in one
 * storage-sized mutation. SQLite adapters implement the transcript row copy
 * and `session_entries.entry_json` update inside the same write transaction.
 */
export async function restoreSessionFromCompactionCheckpoint(
  params: RestoreSessionFromCompactionCheckpointParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await applySessionCompactionCheckpointMutation({
    buildEntry: params.buildEntry,
    checkpointId: params.checkpointId,
    forkTranscriptFromCheckpoint: params.forkTranscriptFromCheckpoint,
    readKey: params.sessionStoreKey ?? params.sessionKey,
    storePath: params.storePath,
    writeKey: params.sessionKey,
  });
}

/**
 * Removes a session's canonical entry plus any folded legacy-alias rows from
 * the resolved store. Reset and corruption-recovery paths use this to drop a
 * session so the next turn starts fresh; alias cleanup mirrors the store
 * writer's normalized-key rules so stale aliases cannot resurrect the entry.
 */
export async function removeSessionEntry(scope: SessionAccessScope): Promise<void> {
  await updateSessionStore(resolveSessionStorePathForScope(scope), (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey });
    delete store[resolved.normalizedKey];
    for (const legacyKey of resolved.legacyKeys) {
      delete store[legacyKey];
    }
  });
}

/**
 * Applies a session patch projection through the accessor boundary.
 * The resolver sees a read-only snapshot and names the persisted key set; the
 * projector returns one replacement entry without receiving the mutable store.
 */
export async function applySessionPatchProjection<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  return await applyFileSessionEntryPatchProjection(params);
}

/**
 * Applies explicit entry replacements without exposing the backing store shape.
 * The file backend runs selection and replacement under one writer lock; the
 * SQLite backend can map the same callback to a transaction.
 */
export async function applySessionEntryReplacements<T>(params: {
  activeSessionKey?: string;
  /** Limits snapshots and replacement authority to these exact persisted keys. */
  sessionKeys?: readonly string[];
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
  requireWriteSuccess?: boolean;
  skipMaintenance?: boolean;
}): Promise<T> {
  const writerResult = await updateSessionStore(
    params.storePath,
    async (store) => {
      const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
      const entries = selectedKeys
        ? [...selectedKeys].flatMap((sessionKey) => {
            const entry = store[sessionKey];
            return entry ? [{ sessionKey, entry: structuredClone(entry) }] : [];
          })
        : Object.entries(store).map(([sessionKey, entry]) => ({
            sessionKey,
            entry: structuredClone(entry),
          }));
      const operation = await params.update(entries);
      let changed = false;
      for (const replacement of operation.replacements ?? []) {
        if (selectedKeys && !selectedKeys.has(replacement.sessionKey)) {
          throw new Error(
            `Session entry replacement is outside the selected key set: ${replacement.sessionKey}`,
          );
        }
        if (!Object.hasOwn(store, replacement.sessionKey)) {
          continue;
        }
        store[replacement.sessionKey] = structuredClone(replacement.entry);
        changed = true;
      }
      return { changed, result: operation.result };
    },
    {
      activeSessionKey: params.activeSessionKey,
      requireWriteSuccess: params.requireWriteSuccess,
      skipMaintenance: params.skipMaintenance ?? true,
      skipSaveWhenResult: (result) => !result.changed,
    },
  );
  return writerResult.result;
}

/**
 * Runs an operation while preserving one temporary session mapping.
 * The storage backend snapshots exactly the named key before the operation and
 * restores that entry, or deletes it when it did not previously exist, after
 * the operation finishes. SQLite backends can implement the same named
 * preservation lifecycle without exposing mutable store access to callers.
 */
export async function preserveTemporarySessionMapping<T>(
  scope: SessionAccessScope,
  operation: () => Promise<T> | T,
): Promise<TemporarySessionMappingPreservationResult<T>> {
  const snapshot = snapshotTemporarySessionMapping(scope);
  let operationResult: TemporarySessionMappingOperationResult<T>;
  try {
    operationResult = { ok: true, result: await operation() };
  } catch (err) {
    operationResult = { error: err, ok: false };
  }

  const restoreFailure = await restoreTemporarySessionMapping(snapshot);
  if (!operationResult.ok) {
    throw operationResult.error;
  }

  return {
    result: operationResult.result,
    ...(snapshot.canRestore ? {} : { snapshotFailure: snapshot.snapshotFailure }),
    ...(restoreFailure ? { restoreFailure } : {}),
  };
}

/** Removes entries and orphan transcript artifacts owned by a named session lifecycle. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  return await cleanupFileSessionLifecycleArtifacts(params);
}

/** Resets one persisted session entry and transitions its transcript state. */
export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  return await resetFileSessionEntryLifecycle(params);
}

/** Deletes one persisted session entry and transitions its transcript state. */
export async function deleteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteFileSessionEntryLifecycle(params);
}

/** Internal exact-row rollback for failed trusted agent-harness initialization. */
export async function rollbackAgentHarnessSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & { expectedEntry: SessionEntry },
): Promise<DeleteSessionEntryLifecycleResult> {
  return await rollbackFileAgentHarnessSessionEntryLifecycle(params);
}

/** Applies exact entry lifecycle mutations and artifact cleanup at the storage boundary. */
export async function applySessionEntryLifecycleMutation(params: {
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  preserveActiveWork?: boolean;
  archiveReason?: "deleted" | "reset";
  restrictArchivedTranscriptsToStoreDir?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  pruneUnreferencedArtifacts?: {
    olderThanMs: number;
    dryRun?: boolean;
  };
  captureArtifactCleanupError?: boolean;
}): Promise<SessionEntryLifecycleMutationResult> {
  return await applyFileSessionEntryLifecycleMutation(params);
}

/** Purges session entries owned by a deleted agent at the storage boundary. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  return await purgeFileDeletedAgentSessionEntries(params);
}

/**
 * Clears plugin host-owned state inside one resolved session store.
 * This is an internal transaction-sized boundary for the storage backend, not
 * a Plugin SDK API.
 */
export async function cleanupPluginHostSessionStore(
  params: PluginHostSessionCleanupStoreParams,
): Promise<number> {
  return await cleanupFilePluginHostSessionStore(params);
}

/**
 * Persists a runner-driven reset rotation together with transcript replay and
 * optional cleanup. File storage performs these steps sequentially; database
 * backends implement this operation as one lifecycle transaction.
 */
export async function persistSessionResetLifecycle(params: {
  agentId?: string;
  cleanupPreviousTranscript?: boolean;
  nextEntry: SessionEntry;
  nextSessionFile: string;
  previousEntry: SessionEntry;
  previousSessionId?: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ replayedMessages: number }> {
  let persistError: Error | undefined;
  try {
    await updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey] = params.nextEntry;
    });
  } catch (err) {
    persistError = err instanceof Error ? err : new Error(String(err));
  }

  const replayedMessages = await replayRecentUserAssistantMessages({
    sourceTranscript: params.previousEntry.sessionFile,
    targetTranscript: params.nextSessionFile,
    newSessionId: params.nextEntry.sessionId,
  });

  if (params.cleanupPreviousTranscript && params.previousSessionId) {
    await archivePreviousSessionTranscript({
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      previousEntry:
        params.previousEntry.sessionId === params.previousSessionId
          ? params.previousEntry
          : { ...params.previousEntry, sessionId: params.previousSessionId },
      storePath: params.storePath,
    });
  }

  if (persistError) {
    throw persistError;
  }
  return { replayedMessages };
}

/** Loads the reply-session initialization rows without exposing a mutable store. */
export function loadReplySessionInitializationSnapshot(params: {
  storePath: string;
  sessionKey: string;
}): ReplySessionInitializationSnapshot {
  const store = loadSessionStore(params.storePath, { skipCache: true, clone: false });
  const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const entries = cloneSessionEntries(store);
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionStoreEntry({ store: entries, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision({
      entry: currentEntry,
      storePath: params.storePath,
    }),
  };
}

/**
 * Persists one reply-session initialization result and archives the previous
 * transcript after metadata commits. SQLite adapters map the guarded write to a
 * transaction and keep archive failure warning-only, matching file storage.
 */
export async function commitReplySessionInitialization(params: {
  activeSessionKey: string;
  agentId: string;
  expectedRevision: string;
  fallbackSessionFile?: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  onMaintenanceWarning?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  prepareSessionEntry?: (
    context: ReplySessionInitializationCommitContext,
  ) => Promise<SessionEntry> | SessionEntry;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  snapshotEntry?: SessionEntry;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  const committed = await updateSessionStore(
    params.storePath,
    async (store): Promise<ReplySessionInitializationCommitResult> => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
      const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
      const revision = createReplySessionInitializationRevision({
        entry: currentEntry,
        storePath: params.storePath,
      });
      if (revision !== params.expectedRevision) {
        return {
          ok: false,
          ...(currentEntry ? { currentEntry } : {}),
          reason: "stale-snapshot",
          revision,
        };
      }

      const readEntry = (sessionKey: string) => {
        const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
        return entry ? { ...entry } : undefined;
      };
      const preparedSessionEntry = params.prepareSessionEntry
        ? await params.prepareSessionEntry({
            ...(currentEntry ? { currentEntry } : {}),
            readEntry,
            sessionEntry: params.sessionEntry,
          })
        : params.sessionEntry;
      const sessionEntry = resolveInitializedReplySessionEntry({
        agentId: params.agentId,
        ...(currentEntry ? { currentEntry } : {}),
        fallbackSessionFile: params.fallbackSessionFile,
        sessionEntry: preparedSessionEntry,
        storePath: params.storePath,
      });
      // The identity-only guard allows commits when background activity touched
      // non-identity metadata after the snapshot. Merge only the fields that
      // actually changed since the snapshot so heartbeat/delivery/context
      // metadata is not rolled back, while reset-cleared fields (e.g. provider
      // or model overrides on /new) stay cleared.
      store[resolved.normalizedKey] = currentEntry
        ? mergeConcurrentReplySessionMetadata({
            currentEntry,
            preparedEntry: sessionEntry,
            snapshotEntry: params.snapshotEntry ?? params.previousEntry,
          })
        : sessionEntry;
      if (params.retiredEntry) {
        store[params.retiredEntry.key] = params.retiredEntry.entry;
      }
      return {
        ok: true,
        previousSessionTranscript: {},
        sessionEntry: { ...(store[resolved.normalizedKey] ?? sessionEntry) },
        sessionStoreView: cloneSessionEntries(store),
      };
    },
    {
      activeSessionKey: params.activeSessionKey,
      maintenanceConfig: params.maintenanceConfig,
      onWarn: params.onMaintenanceWarning,
      reentrant: true,
      skipSaveWhenResult: (result) => !result.ok,
    },
  );
  if (!committed.ok) {
    return committed;
  }

  const previousSessionTranscript = await archivePreviousSessionTranscript({
    agentId: params.agentId,
    onArchiveError: params.onArchiveError,
    previousEntry: params.previousEntry,
    storePath: params.storePath,
  });
  return {
    ...committed,
    previousSessionTranscript,
  };
}

/**
 * Appends a non-message transcript record such as session or metadata events.
 * Message records must use appendTranscriptMessage so parent links, idempotency,
 * and redaction are preserved.
 */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const transcript = await resolveTranscriptAccess(scope);
  await appendSessionTranscriptEvent({
    event,
    transcriptPath: transcript.sessionFile,
  });
}

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendTranscriptMessage; raw event writes would bypass those invariants.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendTranscriptEvent cannot write message transcript records; use appendTranscriptMessage instead.",
    );
  }
}

/**
 * Appends one transcript message with message-id generation and optional
 * idempotency lookup. The returned message is the redacted persisted value.
 */
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  const transcript = await resolveTranscriptAccess(scope);
  return await appendSessionTranscriptMessage({
    transcriptPath: transcript.sessionFile,
    message: options.message,
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.prepareMessageAfterIdempotencyCheck
      ? { prepareMessageAfterIdempotencyCheck: options.prepareMessageAfterIdempotencyCheck }
      : {}),
    ...(options.useRawWhenLinear !== undefined
      ? { useRawWhenLinear: options.useRawWhenLinear }
      : {}),
  });
}

/**
 * Finds the newest transcript record accepted by the matcher. Reads newest-first
 * with early exit so hot append-path lookups never materialize the whole
 * transcript; missing transcripts match nothing. The match is wrapped so parsed
 * falsy records stay distinguishable from "no match".
 */
export async function findTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: (event: TranscriptEvent) => boolean,
): Promise<{ event: TranscriptEvent } | undefined> {
  const target = resolveSessionTranscriptReadTarget(scope);
  for await (const line of streamSessionTranscriptLinesReverse(target.sessionFile)) {
    try {
      const event = JSON.parse(line) as TranscriptEvent;
      if (match(event)) {
        return { event };
      }
    } catch {
      // Malformed lines are skipped, matching transcript index tolerance.
    }
  }
  return undefined;
}

/** Reads parsed transcript records from an explicit or derived transcript target. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  const target = resolveSessionTranscriptReadTarget(scope);
  const events: TranscriptEvent[] = [];
  // Missing transcripts stream zero lines, so readers get an empty event list
  // instead of a filesystem error; that keeps the read contract storage-neutral.
  for await (const line of streamSessionTranscriptLines(target.sessionFile)) {
    try {
      events.push(JSON.parse(line) as TranscriptEvent);
    } catch {
      // Malformed lines are skipped, matching transcript index tolerance.
    }
  }
  return events;
}

/** Emits a transcript update after resolving the current transcript target. */
export async function publishTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  const transcript = await resolveTranscriptAccess(scope);
  emitSessionTranscriptUpdate({
    ...update,
    sessionFile: transcript.sessionFile,
    ...(transcript.target ? { target: transcript.target } : {}),
  });
}

/**
 * Trims a transcript for manual sessions.compact and clears stale token metadata.
 * This is one storage-sized mutation: future stores can trim transcript rows and
 * update entry metadata inside the same backend transaction.
 */
export async function preflightSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimPreflightResult> {
  const transcript = await resolveManualCompactTranscriptTarget(scope, params.sessionFile);
  if (!transcript) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  let totalLines = 0;
  try {
    for await (const line of streamSessionTranscriptLines(transcript.sessionFile)) {
      if (!line) {
        continue;
      }
      totalLines += 1;
      if (totalLines > maxLines) {
        return { compacted: true };
      }
    }
  } catch {
    return { compacted: false, kept: 0 };
  }
  return { compacted: false, kept: totalLines };
}

export async function trimSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; nowMs?: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimResult> {
  const transcript = await resolveManualCompactTranscriptTarget(scope, params.sessionFile);
  if (!transcript) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  let headerLine: string | undefined;
  const tailLines: string[] = [];
  const maxTailLines = Math.max(0, maxLines - 1);
  let totalLines = 0;
  try {
    for await (const line of streamSessionTranscriptLines(transcript.sessionFile)) {
      totalLines += 1;
      if (totalLines === 1) {
        headerLine = line;
        continue;
      }
      tailLines.push(line);
      if (tailLines.length > maxTailLines) {
        tailLines.shift();
      }
    }
  } catch {
    return { compacted: false, kept: 0 };
  }
  if (totalLines <= maxLines) {
    return { compacted: false, kept: totalLines };
  }

  const lines = normalizeManualCompactTranscriptLines(headerLine, tailLines);
  if (!lines) {
    return { compacted: false, kept: 0 };
  }
  const archived = await replaceTranscriptForManualCompact(transcript.sessionFile, lines);
  await patchSessionEntry(
    {
      ...scope,
      sessionKey: transcript.sessionKey,
      storePath: scope.storePath,
    },
    (entry) => {
      delete entry.contextBudgetStatus;
      delete entry.inputTokens;
      delete entry.outputTokens;
      delete entry.totalTokens;
      delete entry.totalTokensFresh;
      entry.updatedAt = params.nowMs ?? Date.now();
      return entry;
    },
    { replaceEntry: true },
  );

  return { archived, compacted: true, kept: lines.length };
}

function parseManualCompactTranscriptRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeManualCompactTranscriptLines(
  headerLine: string | undefined,
  tailLines: readonly string[],
): string[] | null {
  if (!headerLine) {
    return null;
  }
  const header = parseManualCompactTranscriptRecord(headerLine);
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  const records = tailLines
    .map(parseManualCompactTranscriptRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
  const retainedIds = new Set<string>();
  const transparentParents = new Map<string, string | null>();
  const normalizedRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    let parentId = record.parentId;
    const seenTransparentParents = new Set<string>();
    while (
      typeof parentId === "string" &&
      transparentParents.has(parentId) &&
      !seenTransparentParents.has(parentId)
    ) {
      seenTransparentParents.add(parentId);
      parentId = transparentParents.get(parentId) ?? null;
    }
    let next =
      typeof parentId === "string" && !retainedIds.has(parentId)
        ? { ...record, parentId: null }
        : parentId !== record.parentId
          ? { ...record, parentId }
          : record;
    if (next.type === "leaf") {
      const targetId = next.targetId;
      const validTargetId =
        targetId === null || (typeof targetId === "string" && targetId.trim().length > 0);
      if (!validTargetId && typeof next.id === "string") {
        transparentParents.set(
          next.id,
          next.parentId === null || typeof next.parentId === "string" ? next.parentId : null,
        );
      }
      if (typeof targetId === "string" && targetId.trim() && !retainedIds.has(targetId)) {
        // The selected branch fell outside the retained window. Select an
        // empty root instead of accidentally activating abandoned or side rows.
        next = { ...next, targetId: null, appendParentId: null };
      } else if (
        validTargetId &&
        typeof next.appendParentId === "string" &&
        !retainedIds.has(next.appendParentId)
      ) {
        next = { ...next, appendParentId: targetId };
      }
    }
    if (next.type === "compaction" && typeof next.id === "string") {
      const firstKeptEntryId = next.firstKeptEntryId;
      if (typeof firstKeptEntryId === "string" && firstKeptEntryId !== next.id) {
        const tree = scanSessionTranscriptTree([...normalizedRecords, next]);
        const branchPath = selectSessionTranscriptTreePathNodes(tree, next.id);
        if (!branchPath.some((node) => node.id === firstKeptEntryId)) {
          // Replay starts at the earliest retained entry on this compaction's
          // normalized branch, never at an abandoned row earlier in file order.
          next = { ...next, firstKeptEntryId: branchPath[0]?.id ?? next.id };
        }
      }
    }
    normalizedRecords.push(next);
    if (typeof next.id === "string" && next.id.trim()) {
      retainedIds.add(next.id);
    }
  }
  return [JSON.stringify(header), ...normalizedRecords.map((record) => JSON.stringify(record))];
}

async function replaceTranscriptForManualCompact(
  filePath: string,
  lines: readonly string[],
): Promise<string> {
  const archived = `${filePath}.bak.${formatSessionArchiveTimestamp()}`;
  const replacement = `${filePath}.compact.${randomUUID()}.tmp`;
  try {
    await writeJsonlLines(replacement, lines, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(filePath, archived);
    try {
      await fs.promises.rename(replacement, filePath);
    } catch (err) {
      await fs.promises.rename(archived, filePath).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    await fs.promises.unlink(replacement).catch(() => undefined);
    throw err;
  }
  emitSessionTranscriptUpdate({ sessionFile: archived });
  emitSessionTranscriptUpdate({ sessionFile: filePath });
  return archived;
}

async function resolveManualCompactTranscriptTarget(
  scope: SessionTranscriptRuntimeScope,
  sessionFile?: string,
): Promise<SessionTranscriptRuntimeTarget | null> {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const candidates = resolveManualCompactTranscriptCandidates({
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    storePath: scope.storePath,
  });
  for (const candidate of candidates) {
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) {
      return {
        agentId,
        sessionFile: candidate,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      };
    }
  }
  return null;
}

function resolveManualCompactTranscriptCandidates(params: {
  agentId?: string;
  sessionFile?: string;
  sessionId: string;
  storePath?: string;
}): string[] {
  const candidates: string[] = [];
  const sessionFileState = classifyGeneratedTranscriptCandidate(
    params.sessionId,
    params.sessionFile,
  );
  const pushCandidate = (resolve: () => string): void => {
    try {
      const candidate = resolve();
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    } catch {
      // Keep scanning the remaining file-backed candidates.
    }
  };

  if (params.storePath) {
    const sessionsDir = path.dirname(params.storePath);
    if (params.sessionFile && sessionFileState !== "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(
          params.sessionId,
          { sessionFile: params.sessionFile },
          { sessionsDir, agentId: params.agentId },
        ),
      );
    }
    pushCandidate(() => resolveSessionTranscriptPathInDir(params.sessionId, sessionsDir));
    if (params.sessionFile && sessionFileState === "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(
          params.sessionId,
          { sessionFile: params.sessionFile },
          { sessionsDir, agentId: params.agentId },
        ),
      );
    }
  } else if (params.sessionFile) {
    if (params.agentId) {
      if (sessionFileState !== "stale") {
        pushCandidate(() =>
          resolveSessionFilePath(
            params.sessionId,
            { sessionFile: params.sessionFile },
            { agentId: params.agentId },
          ),
        );
      }
    } else {
      const trimmed = params.sessionFile.trim();
      if (trimmed) {
        candidates.push(path.resolve(trimmed));
      }
    }
  }

  if (params.agentId) {
    pushCandidate(() => resolveSessionTranscriptPath(params.sessionId, params.agentId));
    if (params.sessionFile && sessionFileState === "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(
          params.sessionId,
          { sessionFile: params.sessionFile },
          { agentId: params.agentId },
        ),
      );
    }
  }

  const legacyDir = path.join(
    resolveRequiredHomeDir(process.env, os.homedir),
    ".openclaw",
    "sessions",
  );
  pushCandidate(() => resolveSessionTranscriptPathInDir(params.sessionId, legacyDir));
  return candidates;
}

function classifyGeneratedTranscriptCandidate(
  sessionId: string,
  sessionFile?: string,
): "current" | "stale" | "custom" {
  const transcriptSessionId = extractGeneratedTranscriptSessionId(sessionFile);
  if (!transcriptSessionId) {
    return "custom";
  }
  return transcriptSessionId === sessionId ? "current" : "stale";
}

/**
 * Persists one logical transcript turn through the current file-backed writer.
 * The file implementation resolves/rebinds the transcript file, holds one
 * session write lock across all message appends, optionally touches session
 * metadata, then publishes after the write has completed.
 *
 * SQLite implementation note: the transcript row append(s), sessionFile marker,
 * and requested updatedAt touch become one SQLite write transaction; transcript
 * update delivery must run only after commit.
 */
export async function persistSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  options: SessionTranscriptTurnPersistOptions,
): Promise<SessionTranscriptTurnPersistResult> {
  const expectedSessionId = options.expectedSessionId;
  if (expectedSessionId) {
    return await persistExpectedSessionTranscriptTurn(scope, { ...options, expectedSessionId });
  }
  const target = await resolveTranscriptTurnTarget(scope);
  const appendedMessages = await appendTranscriptTurnMessages(target, options);
  const appendedCount = countAppendedTranscriptMessages(appendedMessages);
  const sessionEntry = await touchTranscriptTurnSessionEntry({
    scope,
    target,
    shouldTouch: options.touchSessionEntry === true && appendedCount > 0,
  });
  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages,
  });

  return {
    appendedCount,
    messages: appendedMessages,
    sessionEntry,
    sessionFile: target.sessionFile,
  };
}

async function appendTranscriptTurnMessages(
  target: SessionTranscriptTurnWriteContext,
  options: SessionTranscriptTurnPersistOptions,
): Promise<TranscriptMessageAppendResult<unknown>[]> {
  const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
  const publishedEntries: OwnedSessionTranscriptPublishedEntry[] = [];
  const appendMessages = async (appendMessage: SessionTranscriptTurnAppendRunner) => {
    for (const append of options.messages) {
      const shouldAppend = append.shouldAppend
        ? await append.shouldAppend({
            ...(target.agentId ? { agentId: target.agentId } : {}),
            sessionFile: target.sessionFile,
            ...(target.sessionId ? { sessionId: target.sessionId } : {}),
            ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
          })
        : true;
      if (!shouldAppend) {
        continue;
      }
      const result = await appendMessage({
        transcriptPath: target.sessionFile,
        message: append.message,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
        ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        ...(append.idempotencyLookup ? { idempotencyLookup: append.idempotencyLookup } : {}),
        ...(append.now !== undefined ? { now: append.now } : {}),
        ...(append.prepareMessageAfterIdempotencyCheck
          ? { prepareMessageAfterIdempotencyCheck: append.prepareMessageAfterIdempotencyCheck }
          : {}),
        onHeaderCreated: (header) => {
          publishedEntries.push({ kind: "header", serialized: header });
        },
        ...(append.useRawWhenLinear !== undefined
          ? { useRawWhenLinear: append.useRawWhenLinear }
          : {}),
      });
      if (result) {
        appendedMessages.push(result);
        if (result.appended) {
          publishedEntries.push({ kind: "id", id: result.messageId });
        }
      }
    }
  };
  const activeLockRunner = resolveOwnedSessionTranscriptWriteLockRunner({
    sessionFile: target.sessionFile,
    sessionKey: target.sessionKey,
  });
  const runBatchWithOwnedLock = async () =>
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: target.sessionFile,
        sessionKey: target.sessionKey,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => await appendMessages(appendSessionTranscriptMessageWithOwnedWriteLock),
    );
  if (activeLockRunner) {
    await activeLockRunner(
      () => withSessionTranscriptAppendQueue(target.sessionFile, runBatchWithOwnedLock),
      {
        publishOwnedWrite: true,
        resolvePublishedEntries: () => publishedEntries,
        resolvePublishedEntriesAfterFailure: () => publishedEntries,
      },
    );
  } else {
    await withSessionTranscriptAppendQueue(target.sessionFile, async () => {
      const lock = await acquireSessionWriteLock({
        sessionFile: target.sessionFile,
        ...resolveSessionWriteLockOptions(options.config),
        allowReentrant: true,
      });
      try {
        await runBatchWithOwnedLock();
      } finally {
        await lock.release();
      }
    });
  }
  return appendedMessages;
}

function countAppendedTranscriptMessages(
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): number {
  return messages.filter((message) => message.appended).length;
}

async function persistExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  options: SessionTranscriptTurnPersistOptions & { expectedSessionId: string },
): Promise<SessionTranscriptTurnPersistResult> {
  const sessionKey = scope.sessionKey?.trim();
  if (!scope.storePath || !sessionKey) {
    throw new Error("Cannot guard a transcript turn without a session store and key");
  }
  const expectedSessionId = options.expectedSessionId;
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const store =
    scope.sessionStore ?? loadSessionStore(scope.storePath, { skipCache: true, clone: false });
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  let appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
  let target: SessionTranscriptTurnWriteContext = {
    agentId,
    sessionFile:
      scope.sessionFile ??
      resolveSessionTranscriptPathInDir(expectedSessionId, path.dirname(scope.storePath)),
    sessionId: expectedSessionId,
    sessionKey: resolved.normalizedKey,
  };
  let rejectedEntry: SessionEntry | undefined;
  let touchUpdatedAt: number | undefined;

  const updated = await updateSessionEntry(
    {
      sessionKey: resolved.normalizedKey,
      storePath: scope.storePath,
    },
    async (currentEntry) => {
      if (
        currentEntry.sessionId !== expectedSessionId ||
        (options.expectedLifecycleRevision !== undefined &&
          currentEntry.lifecycleRevision !== options.expectedLifecycleRevision)
      ) {
        rejectedEntry = currentEntry;
        return null;
      }
      const sessionFile =
        scope.sessionFile ??
        resolveSessionFilePath(
          currentEntry.sessionId,
          currentEntry,
          resolveSessionFilePathOptions({
            agentId,
            storePath: scope.storePath,
          }),
        );
      target = {
        agentId,
        sessionFile,
        sessionId: currentEntry.sessionId,
        sessionKey: resolved.normalizedKey,
      };
      appendedMessages = await appendTranscriptTurnMessages(target, options);
      const appendedCount = countAppendedTranscriptMessages(appendedMessages);
      if (options.touchSessionEntry === true && appendedCount > 0) {
        touchUpdatedAt = Date.now();
      }
      const patch = {
        ...(currentEntry.sessionFile === sessionFile ? {} : { sessionFile }),
        ...(touchUpdatedAt !== undefined
          ? { updatedAt: Math.max(currentEntry.updatedAt ?? 0, touchUpdatedAt) }
          : {}),
      };
      return Object.keys(patch).length > 0 ? patch : null;
    },
    { skipMaintenance: true },
  );

  if (
    rejectedEntry ||
    updated?.sessionId !== expectedSessionId ||
    (options.expectedLifecycleRevision !== undefined &&
      updated.lifecycleRevision !== options.expectedLifecycleRevision)
  ) {
    return {
      appendedCount: 0,
      messages: [],
      rejectedReason: "session-rebound",
      sessionEntry: rejectedEntry ?? updated ?? undefined,
      sessionFile: target.sessionFile,
    };
  }

  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages,
  });

  if (updated && scope.sessionStore) {
    scope.sessionStore[resolved.normalizedKey] = updated;
  }
  return {
    appendedCount: countAppendedTranscriptMessages(appendedMessages),
    messages: appendedMessages,
    sessionEntry: updated ?? scope.sessionEntry,
    sessionFile: target.sessionFile,
  };
}

/**
 * Resolves the current file-backed target for a storage-neutral runtime
 * transcript scope. Callers use the scope as identity; sessionFile is returned
 * only for current file-backed implementation details such as locks/events.
 */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const { agentId, sessionEntry, sessionKey, sessionStore } =
    resolveSessionTranscriptRuntimeContext(scope);
  if (scope.sessionFile?.trim()) {
    return {
      agentId,
      sessionFile: path.resolve(scope.sessionFile),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  if (sessionStore && scope.storePath) {
    const sessionsDir = path.dirname(path.resolve(scope.storePath));
    const threadId = scope.threadId ?? parseSessionThreadInfo(scope.sessionKey).threadId;
    const shouldUseDerivedSessionFile =
      !sessionEntry?.sessionFile || sessionEntry.sessionId !== scope.sessionId;
    const fallbackSessionFile =
      shouldUseDerivedSessionFile && threadId !== undefined
        ? resolveSessionTranscriptPathInDir(scope.sessionId, sessionsDir, threadId)
        : undefined;
    const resolved = await resolveAndPersistSessionFile({
      agentId,
      fallbackSessionFile,
      sessionEntry,
      sessionId: scope.sessionId,
      sessionKey,
      sessionStore,
      sessionsDir,
      storePath: scope.storePath,
    });
    return {
      agentId,
      sessionFile: resolved.sessionFile,
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  const resolved = await resolveSessionTranscriptFile({
    agentId,
    sessionEntry,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(sessionStore ? { sessionStore } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
  });
  return {
    agentId,
    sessionFile: resolved.sessionFile,
    sessionId: scope.sessionId,
    sessionKey,
  };
}

/**
 * Resolves the file-backed runtime transcript target for read/delete probes
 * without persisting missing sessionFile metadata into the session store.
 */
export async function resolveSessionTranscriptRuntimeReadTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const { agentId, sessionEntry, sessionKey } = resolveSessionTranscriptRuntimeContext(scope);
  if (scope.sessionFile?.trim()) {
    return {
      agentId,
      sessionFile: path.resolve(scope.sessionFile),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  const matchingSessionEntry =
    sessionEntry?.sessionId === scope.sessionId ? sessionEntry : undefined;
  if (scope.storePath) {
    const sessionsDir = path.dirname(path.resolve(scope.storePath));
    const threadId = scope.threadId ?? parseSessionThreadInfo(sessionKey).threadId;
    const sessionFile = matchingSessionEntry?.sessionFile
      ? resolveSessionFilePath(scope.sessionId, matchingSessionEntry, { agentId, sessionsDir })
      : resolveSessionTranscriptPathInDir(scope.sessionId, sessionsDir, threadId);
    return {
      agentId,
      sessionFile,
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  const threadId = scope.threadId ?? parseSessionThreadInfo(sessionKey).threadId;
  const sessionFile = matchingSessionEntry?.sessionFile
    ? resolveSessionFilePath(scope.sessionId, matchingSessionEntry, { agentId })
    : resolveSessionTranscriptPath(scope.sessionId, agentId, threadId);
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    sessionKey,
  };
}

type SessionTranscriptRuntimeContext = {
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry> | undefined;
};

function resolveSessionTranscriptRuntimeContext(
  scope: SessionTranscriptRuntimeScope,
): SessionTranscriptRuntimeContext {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const sessionStore = scope.storePath
    ? loadSessionStore(scope.storePath, { skipCache: true })
    : undefined;
  const resolvedStoreEntry = sessionStore
    ? resolveSessionStoreEntry({ store: sessionStore, sessionKey: scope.sessionKey })
    : undefined;
  const sessionEntry = resolvedStoreEntry?.existing ?? loadSessionEntry(scope);
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  return {
    agentId,
    sessionKey,
    sessionStore,
    sessionEntry,
  };
}

/**
 * Resolves the current file-backed target for read-only transcript callers.
 * Unlike writer/runtime resolution, this does not persist missing sessionFile
 * metadata; reader projections must not mutate session metadata.
 */
export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  const explicitSessionFile = scope.sessionFile?.trim();
  if (explicitSessionFile) {
    return {
      sessionFile: explicitSessionFile,
      sessionId: scope.sessionId,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const storePath = resolveConcreteReadStorePath(scope.storePath);
  const resolvedStoreEntry =
    scope.sessionEntry || !scope.sessionKey
      ? undefined
      : storePath
        ? resolveSessionStoreEntry({
            store: loadSessionStore(storePath, { skipCache: true }),
            sessionKey: scope.sessionKey,
          })
        : undefined;
  const sessionEntry =
    scope.sessionEntry ??
    resolvedStoreEntry?.existing ??
    (scope.sessionKey ? loadSessionEntry({ ...scope, sessionKey: scope.sessionKey }) : undefined);
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  const matchingSessionEntry =
    sessionEntry?.sessionId === undefined || sessionEntry.sessionId === scope.sessionId
      ? sessionEntry
      : undefined;
  const threadId =
    scope.threadId ?? (sessionKey ? parseSessionThreadInfo(sessionKey).threadId : undefined);
  const sessionFile = matchingSessionEntry?.sessionFile
    ? resolveSessionFilePath(
        scope.sessionId,
        matchingSessionEntry,
        resolveSessionFilePathOptions({
          agentId,
          ...(storePath ? { storePath } : {}),
        }),
      )
    : storePath
      ? resolveSessionTranscriptPathInDir(
          // File-backed readers derive beside sessions.json only for the JSON-store
          // deprecation window; the SQLite flip resolves from canonical metadata.
          scope.sessionId,
          path.dirname(path.resolve(storePath)),
          threadId,
        )
      : resolveSessionTranscriptPath(scope.sessionId, agentId, threadId);
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

export type SessionStoreEntrySnapshot = {
  entry?: SessionEntry;
  normalizedKey: string;
  store: Record<string, SessionEntry>;
};

export function loadSessionStoreEntrySnapshot(params: {
  sessionKey: string;
  storePath: string;
}): SessionStoreEntrySnapshot {
  const store = loadSessionStore(params.storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
  return {
    ...(resolved.existing ? { entry: resolved.existing } : {}),
    normalizedKey: resolved.normalizedKey,
    store,
  };
}
function resolveConcreteReadStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}

function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
}

function snapshotTemporarySessionMapping(
  scope: SessionAccessScope,
): TemporarySessionMappingSnapshot {
  const storePath = resolveSessionStorePathForScope(scope);
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[scope.sessionKey];
    return {
      canRestore: true,
      ...(entry ? { entry: structuredClone(entry), hadEntry: true } : { hadEntry: false }),
      sessionKey: scope.sessionKey,
      storePath,
    };
  } catch (err) {
    return {
      canRestore: false,
      sessionKey: scope.sessionKey,
      snapshotFailure: formatErrorMessage(err),
      storePath,
    };
  }
}

async function restoreTemporarySessionMapping(
  snapshot: TemporarySessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    await updateSessionStore(
      snapshot.storePath,
      (store) => {
        if (snapshot.hadEntry) {
          store[snapshot.sessionKey] = structuredClone(snapshot.entry);
          return;
        }
        delete store[snapshot.sessionKey];
      },
      { activeSessionKey: snapshot.sessionKey },
    );
    return undefined;
  } catch (err) {
    return formatErrorMessage(err);
  }
}

async function archivePreviousSessionTranscript(params: {
  agentId: string;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  previousEntry?: SessionEntry;
  storePath: string;
}): Promise<SessionLifecycleTranscriptInfo> {
  if (!params.previousEntry?.sessionId) {
    return {};
  }
  const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
    await loadSessionArchiveRuntime();
  const archivedTranscripts = archiveSessionTranscriptsDetailed({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.previousEntry.sessionFile,
    agentId: params.agentId,
    reason: "reset",
    onArchiveError: params.onArchiveError,
  });
  return resolveStableSessionEndTranscript({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.previousEntry.sessionFile,
    agentId: params.agentId,
    archivedTranscripts,
  });
}

type ResolvedTranscriptAccess = {
  sessionFile: string;
  target?: SessionTranscriptUpdateTarget;
};

function projectTranscriptUpdateTarget(
  target: Pick<Partial<SessionTranscriptRuntimeTarget>, "agentId" | "sessionId" | "sessionKey">,
): SessionTranscriptUpdateTarget | undefined {
  if (!target.agentId || !target.sessionId || !target.sessionKey) {
    return undefined;
  }
  return {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  };
}

async function resolveTranscriptAccess(
  scope: SessionTranscriptWriteScope,
): Promise<ResolvedTranscriptAccess> {
  if (scope.sessionFile?.trim()) {
    const scopeSessionKey = scope.sessionKey?.trim();
    const agentId = scopeSessionKey
      ? (scope.agentId ?? resolveAgentIdFromSessionKey(scopeSessionKey))
      : undefined;
    return {
      sessionFile: scope.sessionFile,
      ...(agentId && scope.sessionId && scopeSessionKey
        ? {
            target: projectTranscriptUpdateTarget({
              agentId,
              sessionId: scope.sessionId,
              sessionKey: scopeSessionKey,
            }),
          }
        : {}),
    };
  }
  if (!scope.sessionId) {
    throw new Error(`Cannot resolve transcript scope without a session id: ${scope.sessionKey}`);
  }
  // Past this point resolution goes through the session entry, so the owning
  // key is mandatory; explicit-artifact writes returned above never need it.
  const scopeSessionKey = scope.sessionKey?.trim();
  if (!scopeSessionKey) {
    throw new Error(
      "Cannot resolve a transcript write scope without a session key or explicit session file",
    );
  }
  const target = await resolveSessionTranscriptRuntimeTarget({
    ...scope,
    sessionId: scope.sessionId,
    sessionKey: scopeSessionKey,
  });
  const updateTarget = projectTranscriptUpdateTarget(target);
  return {
    sessionFile: target.sessionFile,
    ...(updateTarget ? { target: updateTarget } : {}),
  };
}

async function resolveTranscriptTurnTarget(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
): Promise<
  SessionTranscriptTurnWriteContext & {
    sessionEntry: SessionEntry | undefined;
  }
> {
  if (scope.sessionFile?.trim()) {
    return {
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      sessionFile: scope.sessionFile,
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
      sessionEntry: scope.sessionEntry,
    };
  }
  const sessionKey = scope.sessionKey?.trim();
  if (!sessionKey || !scope.sessionId) {
    throw new Error(
      "Cannot persist a transcript turn without a session key and session id or explicit session file",
    );
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const store =
    scope.sessionStore ??
    (scope.storePath ? loadSessionStore(scope.storePath, { skipCache: true }) : undefined);
  const resolved = store ? resolveSessionStoreEntry({ store, sessionKey }) : undefined;
  const sessionEntry =
    resolved?.existing ?? scope.sessionEntry ?? loadSessionEntry({ ...scope, sessionKey });
  const resolvedFile = await resolveSessionTranscriptFile({
    agentId,
    sessionEntry,
    sessionId: scope.sessionId,
    sessionKey,
    ...(store ? { sessionStore: store } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
  });
  return {
    agentId,
    sessionFile: resolvedFile.sessionFile,
    sessionId: scope.sessionId,
    sessionKey: resolved?.normalizedKey ?? sessionKey,
    sessionEntry: resolvedFile.sessionEntry,
  };
}

async function touchTranscriptTurnSessionEntry(params: {
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  };
  target: SessionTranscriptTurnWriteContext & {
    sessionEntry: SessionEntry | undefined;
  };
  shouldTouch: boolean;
}): Promise<SessionEntry | undefined> {
  if (
    !params.shouldTouch ||
    !params.scope.storePath ||
    !params.target.sessionKey ||
    !params.target.sessionId
  ) {
    return params.target.sessionEntry;
  }
  const markerUpdatedAt = Date.now();
  const updated = await updateSessionEntry(
    {
      sessionKey: params.target.sessionKey,
      storePath: params.scope.storePath,
    },
    (current) =>
      current.sessionId === params.target.sessionId
        ? {
            sessionFile: params.target.sessionFile,
            updatedAt: Math.max(current.updatedAt ?? 0, markerUpdatedAt),
          }
        : null,
    { skipMaintenance: true },
  );
  if (updated && params.scope.sessionStore) {
    params.scope.sessionStore[params.target.sessionKey] = updated;
  }
  return updated ?? params.target.sessionEntry;
}

async function publishTranscriptTurnUpdate(params: {
  target: SessionTranscriptTurnWriteContext;
  updateMode: SessionTranscriptTurnUpdateMode;
  publishWhen: "always" | "when-appended";
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
}): Promise<void> {
  if (params.updateMode === "none") {
    return;
  }
  const lastAppended = params.appendedMessages.findLast((message) => message.appended);
  if (params.publishWhen === "when-appended" && !lastAppended) {
    return;
  }
  emitSessionTranscriptUpdate({
    ...(params.target.sessionKey ? { sessionKey: params.target.sessionKey } : {}),
    ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    ...(params.updateMode === "inline" && lastAppended
      ? {
          message: lastAppended.message,
          messageId: lastAppended.messageId,
        }
      : {}),
    sessionFile: params.target.sessionFile,
  });
}
