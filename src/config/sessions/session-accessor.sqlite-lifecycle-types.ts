import type { SessionLifecycleArchivedTranscript } from "./session-accessor.lifecycle-types.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive.js";
import type { SessionEntryLifecycleRemoval } from "./session-accessor.sqlite-contract.js";
import type { SessionResetBoundaryPlan } from "./session-reset-boundary-event.js";
import type { SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

export type SessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  sessionKey: string;
};
type SessionEntryMaintenanceCounts = {
  modelRunPruned: number;
  pruned: number;
  capped: number;
};
export type SessionEntryMaintenancePlan = SessionEntryMaintenanceCounts & {
  entryRemovals: SessionEntryRemovalPlan[];
  stateDeletePlans: SessionStateDeletePlan[];
};
export type SessionEntryMaintenanceResult = SessionEntryMaintenanceCounts & {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
};
export type LifecycleArtifactCleanupPlan = {
  deletePlans: SessionStateDeletePlan[];
  entries: SessionEntryRemovalPlan[];
};
export type ProjectedLifecycleMutation = {
  deletePlans: SessionStateDeletePlan[];
  removals: Array<{
    expectedEntry: SessionEntry;
    removal: SessionEntryLifecycleRemoval;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    resetBoundaryPlan?: SessionResetBoundaryPlan;
    sessionKey: string;
  }>;
};
