// Stable SQLite accessor surface. Domain owners live in the focused modules below.
export {
  countSqliteSessionEntryRowsReadOnly,
  ensureSqliteSessionEntrySync,
  hasSqliteSessionEntriesByStatusReadOnly,
  listSqliteSessionEntries,
  listSqliteSessionChildEntriesReadOnly,
  listSqliteSessionEntriesReadOnly,
  listSqliteSessionEntryKeysReadOnly,
  listSqliteSessionEntriesByStatus,
  listSqliteSessionTranscriptInstances,
  loadExactSqliteSessionEntry,
  loadExactSqliteSessionEntryReadOnly,
  loadSqliteSessionEntry,
  loadSqliteSessionEntryReadOnly,
  patchSqliteSessionEntry,
  patchSqliteSessionEntryTarget,
  readSqliteSessionUpdatedAt,
  recordSqliteInboundSessionMeta,
  replaceSqliteSessionEntry,
  replaceSqliteSessionEntrySync,
  resolveSqliteSessionEntry,
  resolveSqliteSessionKeyBySessionId,
  updateSqliteSessionLastRoute,
  upsertSqliteSessionEntry,
} from "./session-accessor.sqlite-entry.js";
export {
  copySqliteSessionOwnedStateForCanonicalRepair,
  listSqliteSessionEntriesForCanonicalRepair,
  listSqliteSessionGenerationIdsForCanonicalRepair,
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepair,
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch,
} from "./session-accessor.sqlite-canonical-repair.js";
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
export { applySqliteSessionEntryBatchProjection } from "./session-accessor.sqlite-batch-projection.js";
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
  resolveSessionTranscriptActiveLeafEntryId,
  rewindSqliteSessionToMessage,
  switchSqliteSessionBranch,
} from "./session-accessor.sqlite-message-cut.js";
export {
  appendSqliteExpectedSessionTranscriptTurn,
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptEventSync,
  appendSqliteTranscriptMessage,
  appendSqliteTranscriptMessageSync,
  replaceSqliteTranscriptEvents,
  replaceSqliteTranscriptEventsSync,
  rewriteSqliteTranscriptEventRowsExact,
  trimSqliteTranscriptForManualCompact,
  withSqliteTranscriptWriteLock,
  withSqliteTranscriptWriteTransaction,
} from "./session-accessor.sqlite-transcript-write.js";
export { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
export { publishSqliteTranscriptUpdate } from "./session-accessor.sqlite-events.js";
export { readSqliteTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
export {
  findSqliteTranscriptEvent,
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEventRowsAfterSeqSync,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsSync,
  loadSqliteTranscriptHeaderSync,
  loadSqliteTranscriptTailEventsSync,
  readSqliteTranscriptEventAtSeqSync,
  readSqliteTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
