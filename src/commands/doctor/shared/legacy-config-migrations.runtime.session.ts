// Legacy session runtime config migrations for retired maintenance/fork sizing keys.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function hasLegacyRotateBytes(value: unknown): boolean {
  const maintenance = getRecord(value);
  return Boolean(maintenance && Object.hasOwn(maintenance, "rotateBytes"));
}

function hasLegacyParentForkMaxTokens(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.hasOwn(session, "parentForkMaxTokens"));
}

const LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.rotateBytes is deprecated and ignored; run "openclaw doctor --fix" to remove it.',
  match: hasLegacyRotateBytes,
};

const LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.parentForkMaxTokens was removed; parent fork sizing is automatic. Run "openclaw doctor --fix" to remove it.',
  match: hasLegacyParentForkMaxTokens,
};

/** Legacy config migration specs for session runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "session.maintenance.rotateBytes",
    describe: "Remove deprecated session.maintenance.rotateBytes",
    legacyRules: [LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance || !Object.hasOwn(maintenance, "rotateBytes")) {
        return;
      }
      delete maintenance.rotateBytes;
      changes.push("Removed deprecated session.maintenance.rotateBytes.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.parentForkMaxTokens",
    describe: "Remove legacy session.parentForkMaxTokens",
    legacyRules: [LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.hasOwn(session, "parentForkMaxTokens")) {
        return;
      }
      delete session.parentForkMaxTokens;
      changes.push("Removed session.parentForkMaxTokens; parent fork sizing is automatic.");
    },
  }),
];
