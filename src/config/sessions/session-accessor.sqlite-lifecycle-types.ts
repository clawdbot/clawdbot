import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive.js";
import type { SessionEntryLifecycleRemoval } from "./session-accessor.sqlite-contract.js";
import type { SessionResetBoundaryPlan } from "./session-reset-boundary-event.js";
import type { SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

export type SessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  sessionKey: string;
};
export type SessionEntryMaintenancePlan = {
  entryRemovals: SessionEntryRemovalPlan[];
  stateDeletePlans: SessionStateDeletePlan[];
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
