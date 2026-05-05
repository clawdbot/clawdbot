import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { protectActiveAuthProfileConfig } from "../../doctor-auth-profile-config.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

export function applyLegacyCompatibilityStep(params: {
  snapshot: DoctorConfigPreflightResult["snapshot"];
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  issueLines: string[];
  changeLines: string[];
  partiallyValid?: boolean;
} {
  if (params.snapshot.legacyIssues.length === 0) {
    return {
      state: params.state,
      issueLines: [],
      changeLines: [],
    };
  }

  const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
  const { config: migrated, changes, partiallyValid } = migrateLegacyConfig(params.snapshot.parsed);
  if (!migrated) {
    return {
      state: {
        ...params.state,
        pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
        fixHints: params.shouldRepair
          ? params.state.fixHints
          : [
              ...params.state.fixHints,
              `Run "${params.doctorFixCommand}" to migrate legacy config keys.`,
            ],
      },
      issueLines,
      changeLines: changes,
    };
  }

  return {
    state: {
      // Doctor should keep using the best-effort migrated shape in memory even
      // during preview mode; confirmation only controls whether we write it.
      // When partiallyValid, the migration succeeded but unrelated validation issues
      // remain — still commit the migration so doctor --fix always applies safe migrations
      // even when other problems prevent full validation from passing.
      cfg: migrated,
      candidate: migrated,
      // The read path can normalize legacy config into the snapshot before
      // migrateLegacyConfig emits concrete mutations. Legacy issues still mean
      // the on-disk config needs a doctor --fix path.
      pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [
            ...params.state.fixHints,
            `Run "${params.doctorFixCommand}" to ${partiallyValid ? "finish fixing" : "migrate"} legacy config keys.`,
          ],
    },
    issueLines,
    changeLines: changes,
    partiallyValid: partiallyValid === true ? true : undefined,
  };
}

export function applyUnknownConfigKeyStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
  repairs: string[];
  warnings: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { state: params.state, removed: [], repairs: [], warnings: [] };
  }
  const protectedAuth = protectActiveAuthProfileConfig({
    before: params.state.candidate,
    after: unknown.config,
  });

  return {
    state: {
      cfg: params.shouldRepair ? protectedAuth.config : params.state.cfg,
      candidate: protectedAuth.config,
      pendingChanges: true,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`],
    },
    removed: unknown.removed,
    repairs: protectedAuth.repairs,
    warnings: protectedAuth.warnings,
  };
}
