/** Re-exports legacy state migration helpers used by doctor preflight. */
export type { LegacyStateDetection } from "../infra/state-migrations.js";
export { migrateLegacyConfigMachineState } from "../infra/state-migrations.config-machine-state.js";
export {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  migrateLegacyAgentDir,
  migrateHistoricalTranscriptDirectives,
  migrateLegacyMediaPersistence,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "../infra/state-migrations.js";
