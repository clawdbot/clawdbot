import type { SqliteSessionStateDeletePlan } from "./session-accessor.sqlite-archive.js";
import type { SessionEntryLifecycleRemoval } from "./session-accessor.sqlite-contract.js";
import type { SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

export type SqliteSessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  sessionKey: string;
};
export type SqliteSessionEntryMaintenancePlan = {
  entryRemovals: SqliteSessionEntryRemovalPlan[];
  stateDeletePlans: SqliteSessionStateDeletePlan[];
};
export type SqliteLifecycleArtifactCleanupPlan = {
  deletePlans: SqliteSessionStateDeletePlan[];
  entries: SqliteSessionEntryRemovalPlan[];
};
export type SqliteProjectedLifecycleMutation = {
  deletePlans: SqliteSessionStateDeletePlan[];
  removals: Array<{
    expectedEntry: SessionEntry;
    removal: SessionEntryLifecycleRemoval;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    sessionKey: string;
  }>;
};
