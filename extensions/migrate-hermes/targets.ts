// Migrate Hermes plugin re-exports the shared migration target resolution.
export {
  resolvePlannedMigrationTargets as resolveTargets,
  type PlannedMigrationTargets as PlannedTargets,
} from "openclaw/plugin-sdk/migration-runtime";
