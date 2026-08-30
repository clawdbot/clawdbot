import type { ConversationRouteContext } from "./conversation-route-context.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.lifecycle-types.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive.js";
import type { SessionEntryLifecycleRemoval } from "./session-accessor.sqlite-contract.js";
import type { SessionResetBoundaryRequest } from "./session-reset-boundary-event.js";
import type { SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

export type SessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  maintenanceReason?: "capped" | "model-run-pruned" | "pruned";
  sessionKey: string;
};
type SessionEntryMaintenanceCounts = {
  archived: number;
  modelRunPruned: number;
  pruned: number;
  capped: number;
};
export type SessionEntryMaintenancePlan = SessionEntryMaintenanceCounts & {
  archivedWorktrees?: Array<{ entry: SessionEntry; sessionKey: string; storePath: string }>;
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
    routeContext?: ConversationRouteContext | null;
    resetBoundary?: SessionResetBoundaryRequest;
    sessionKey: string;
  }>;
};
