// Stable SQLite accessor surface. Domain owners live in the focused modules below.
export {
  listSqliteSessionEntries,
  listSqliteSessionEntriesByStatus,
  listSqliteSessionTranscriptInstances,
  loadExactSqliteSessionEntry,
  loadSqliteSessionEntry,
  loadSqliteSessionEntryReadOnly,
  patchSqliteSessionEntry,
  patchSqliteSessionEntryTarget,
  readSqliteSessionUpdatedAt,
  recordSqliteInboundSessionMeta,
  replaceSqliteSessionEntry,
  replaceSqliteSessionEntrySync,
  resolveSqliteSessionKeyBySessionId,
  updateSqliteSessionLastRoute,
  upsertSqliteSessionEntry,
} from "./session-accessor.sqlite-entry.js";
export {
  cleanupSqliteSessionLifecycleArtifacts,
  deleteSqliteSessionEntryLifecycle,
  resetSqliteSessionEntryLifecycle,
  rollbackSqliteAgentHarnessSessionEntryLifecycle,
  rollbackSqlitePluginOwnedSessionEntryLifecycle,
} from "./session-accessor.sqlite-lifecycle.js";
export {
  applySqliteSessionEntryLifecycleMutation,
  applySqliteSessionEntryReplacements,
  applySqliteSessionStoreProjection,
  purgeSqliteDeletedAgentSessionEntries,
} from "./session-accessor.sqlite-projection.js";
export {
  forkSqliteSessionEntryFromParentTarget,
  forkSqliteSessionTranscriptFromParent,
  resolveSqliteSessionParentForkDecision,
} from "./session-accessor.sqlite-parent-session.js";
export {
  branchSqliteCompactionCheckpointSession,
  restoreSqliteCompactionCheckpointSession,
} from "./session-accessor.sqlite-checkpoint.js";
export {
  forkSqliteSessionAtMessage,
  listSqliteSessionBranches,
  rewindSqliteSessionToMessage,
  switchSqliteSessionBranch,
} from "./session-accessor.sqlite-message-cut.js";
export {
  appendSqliteExpectedSessionTranscriptTurn,
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptEventSync,
  appendSqliteTranscriptMessage,
  appendSqliteTranscriptMessageSync,
  importSqliteSessionRows,
  replaceSqliteTranscriptEvents,
  replaceSqliteTranscriptEventsSync,
  withSqliteTranscriptWriteLock,
  withSqliteTranscriptWriteTransaction,
} from "./session-accessor.sqlite-transcript-write.js";
export { publishSqliteTranscriptUpdate } from "./session-accessor.sqlite-events.js";
export { readSqliteTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
export { previewSqliteSessionDiskBudget } from "./session-accessor.sqlite-maintenance.js";
export {
  findSqliteTranscriptEvent,
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEventRowsAfterSeqSync,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsSync,
  readSqliteTranscriptEventAtSeqSync,
  readSqliteTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
