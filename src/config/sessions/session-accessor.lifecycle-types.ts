import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionUnreferencedArtifactSweepResult } from "./disk-budget.js";
import type { SessionResetBoundaryReason } from "./session-reset-boundary-event.js";
import type { SessionMaintenanceApplyReport } from "./store-maintenance-operations.js";
import type { SessionEntry } from "./types.js";

export type SessionLifecycleArtifactCleanupParams = {
  agentId?: string;
  storePath: string;
  archiveRemovedEntryTranscripts?: boolean;
  sessionKeySegmentPrefix: string;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs?: number;
};

export type SessionLifecycleArtifactCleanupResult = {
  removedEntries: number;
  archivedTranscriptArtifacts: number;
};

export type SessionLifecycleStoreTarget = {
  canonicalKey: string;
  storeKeys: string[];
};

export type SessionLifecycleArchivedTranscript = {
  sourcePath: string;
  archivedPath: string;
};

export type ResetSessionEntryLifecycleResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  previousEntry?: SessionEntry;
  previousSessionFile?: string;
  previousSessionId?: string;
  nextEntry: SessionEntry;
};

export type ResetSessionEntryLifecycleMutation = Omit<
  ResetSessionEntryLifecycleResult,
  "archivedTranscripts"
>;

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
  resetBoundaryReason?: SessionResetBoundaryReason;
  /** Explicit store target for SQLite session ownership. */
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type DeleteSessionEntryLifecycleResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  deleted: boolean;
  expectedEntryMismatch?: true;
  deletedEntry?: SessionEntry;
  deletedSessionFile?: string;
  deletedSessionId?: string;
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
  /** Explicit store target for SQLite session ownership. */
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type SessionEntryLifecycleRemoval = {
  sessionKey: string;
  expectedEntry?: SessionEntry;
  archiveRemovedTranscript?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedUpdatedAt?: number;
};

export type SessionEntryLifecycleUpsert = {
  sessionKey: string;
  resetBoundaryReason?: SessionResetBoundaryReason;
} & (
  | {
      entry: SessionEntry;
      buildEntry?: never;
    }
  | {
      buildEntry: (context: {
        currentEntry?: SessionEntry;
        sessionKey: string;
        store: Record<string, SessionEntry>;
      }) => Promise<SessionEntry | null | undefined> | SessionEntry | null | undefined;
      entry?: never;
    }
);

export type SessionArchivedTranscriptCleanupRule = {
  reason: "deleted" | "reset";
  olderThanMs: number;
};

export type SessionEntryLifecycleMutationResult = {
  removedEntries: number;
  removedSessionKeys: string[];
  archivedTranscriptDirectories: string[];
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult | null;
  maintenanceReport: SessionMaintenanceApplyReport | null;
  afterCount: number;
  artifactCleanupError?: unknown;
};

export type DeletedAgentSessionEntryPurgeParams = {
  cfg: OpenClawConfig;
  agentId: string;
  storeAgentId: string;
  storePath: string;
};
