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

export type DeleteSessionEntryLifecycleResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  deleted: boolean;
  expectedEntryMismatch?: true;
  deletedEntry?: SessionEntry;
  deletedSessionFile?: string;
  deletedSessionId?: string;
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
