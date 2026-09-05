// Legacy session runtime config migrations for retired maintenance/fork sizing keys.
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../../cli/parse-duration.js";
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

/** Match only parser-valid values that resolve to an unsafe zero-duration cutoff. */
function isZeroDuration(val: unknown): boolean {
  if (val === false) {
    return false;
  }
  const normalized = normalizeStringifiedOptionalString(val);
  if (!normalized) {
    return false;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" }) <= 0;
  } catch {
    return false;
  }
}

function hasZeroDuration(raw: unknown, key: "pruneAfter" | "resetArchiveRetention"): boolean {
  const maintenance = getRecord(raw);
  if (!maintenance || !Object.hasOwn(maintenance, key)) {
    return false;
  }
  return isZeroDuration(maintenance[key]);
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

const SESSION_MAINTENANCE_PRUNE_AFTER_ZERO_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.pruneAfter is a zero duration — this causes immediate deletion of eligible stale/non-preserved session entries. Run "openclaw doctor --fix" to remove it so the documented 30d default applies.',
  match: (raw) => hasZeroDuration(raw, "pruneAfter"),
};

const SESSION_MAINTENANCE_RESET_ARCHIVE_RETENTION_ZERO_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.resetArchiveRetention is a zero duration — this causes immediate deletion of all reset transcript archives. Run "openclaw doctor --fix" to remove it so the keep-by-default archive retention applies.',
  match: (raw) => hasZeroDuration(raw, "resetArchiveRetention"),
};

const SESSION_ALIAS_RULES: LegacyConfigRule[] = [
  {
    path: ["session", "maintenance", "pruneDays"],
    message:
      'session.maintenance.pruneDays was renamed to pruneAfter. Run "openclaw doctor --fix".',
  },
  {
    path: ["session", "resetByType", "dm"],
    message: 'session.resetByType.dm was renamed to direct. Run "openclaw doctor --fix".',
  },
];

/** Legacy config migration specs for session runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "session.canonical-aliases",
    describe: "Move session aliases to canonical keys",
    legacyRules: SESSION_ALIAS_RULES,
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      const maintenance = getRecord(session?.maintenance);
      if (maintenance && Object.hasOwn(maintenance, "pruneDays")) {
        if (maintenance.pruneAfter === undefined) {
          maintenance.pruneAfter = maintenance.pruneDays;
          changes.push("Moved session.maintenance.pruneDays → session.maintenance.pruneAfter.");
        } else {
          changes.push("Removed session.maintenance.pruneDays (pruneAfter already set).");
        }
        delete maintenance.pruneDays;
      }
      const resetByType = getRecord(session?.resetByType);
      if (resetByType && Object.hasOwn(resetByType, "dm")) {
        if (resetByType.direct === undefined) {
          resetByType.direct = resetByType.dm;
          changes.push("Moved session.resetByType.dm → session.resetByType.direct.");
        } else {
          changes.push("Removed session.resetByType.dm (direct already set).");
        }
        delete resetByType.dm;
      }
    },
  }),
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
  defineLegacyConfigMigration({
    id: "session.maintenance.zero-duration-retention",
    describe: "Remove zero-duration session maintenance values so documented defaults apply",
    legacyRules: [
      SESSION_MAINTENANCE_PRUNE_AFTER_ZERO_RULE,
      SESSION_MAINTENANCE_RESET_ARCHIVE_RETENTION_ZERO_RULE,
    ],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance) {
        return;
      }
      for (const key of ["resetArchiveRetention", "pruneAfter"] as const) {
        if (!Object.hasOwn(maintenance, key)) {
          continue;
        }
        const val = maintenance[key];
        if (!isZeroDuration(val)) {
          continue;
        }
        const label = String(val);
        const fieldPath =
          key === "resetArchiveRetention"
            ? "session.maintenance.resetArchiveRetention"
            : "session.maintenance.pruneAfter";
        delete maintenance[key];
        const outcome =
          key === "resetArchiveRetention"
            ? "keep-by-default archive retention applies"
            : "30d session-pruning default applies";
        changes.push(`Removed ${fieldPath} "${label}" (zero duration); ${outcome}.`);
      }
    },
  }),
];
