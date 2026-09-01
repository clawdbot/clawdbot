import { isDeepStrictEqual } from "node:util";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "../../../config/config-path-mutation.js";
import { replaceConfigFile } from "../../../config/config.js";
import { stampConfigWriteMetadata } from "../../../config/io.meta.js";
import { containsConfigIncludeDirective } from "../../../config/io.read-helpers.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectWithPlugins,
} from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";

type AutomaticConfigRepairPlan = {
  config: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  changes: string[];
};

function admitAutomaticConfigRepairSnapshot(snapshot: ConfigFileSnapshot): boolean {
  return (
    !snapshot.valid &&
    snapshot.exists &&
    snapshot.raw !== null &&
    (snapshot.includedPaths?.length ?? 0) === 0 &&
    !containsConfigIncludeDirective(snapshot.parsed)
  );
}

function buildAutomaticConfigRepairPlan(
  snapshot: ConfigFileSnapshot,
  config: OpenClawConfig,
  changes: string[],
): AutomaticConfigRepairPlan {
  return {
    config,
    changes,
    snapshot: {
      ...snapshot,
      sourceConfig: config,
      resolved: config,
      runtimeConfig: config,
      config,
      valid: true,
      issues: [],
      legacyIssues: [],
    },
  };
}

/** Admits only complete, deterministic single-file legacy migrations. */
export function planAutomaticConfigRepair(
  snapshot: ConfigFileSnapshot,
): AutomaticConfigRepairPlan | null {
  if (!admitAutomaticConfigRepairSnapshot(snapshot)) {
    return null;
  }

  const { next: config, changes } = applyLegacyDoctorMigrations(snapshot.sourceConfig, {
    authoredRaw: snapshot.parsed,
    resolvedRaw: snapshot.sourceConfig,
  });
  if (
    !config ||
    isDeepStrictEqual(config, snapshot.sourceConfig) ||
    !validateConfigObjectWithPlugins(config).ok ||
    findDoctorLegacyConfigIssues(config, config).length > 0
  ) {
    return null;
  }

  return buildAutomaticConfigRepairPlan(snapshot, config, changes);
}

/**
 * State-free repairable preview for callers that run before the shared state database
 * may be touched (gateway pre-bootstrap selection, backup discovery). It skips plugin
 * doctor contracts and plugin validation, so it can admit a snapshot the full planner
 * later refuses — the preflight committer and canonical-write matcher stay authoritative,
 * and a refused commit keeps today's fail-closed startup refusal.
 */
function planStartupConfigRepairPreview(
  snapshot: ConfigFileSnapshot,
): AutomaticConfigRepairPlan | null {
  if (!admitAutomaticConfigRepairSnapshot(snapshot)) {
    return null;
  }

  const { next: config, changes } = applyLegacyDoctorMigrations(
    snapshot.sourceConfig,
    { authoredRaw: snapshot.parsed, resolvedRaw: snapshot.sourceConfig },
    { pluginContracts: false },
  );
  if (
    !config ||
    isDeepStrictEqual(config, snapshot.sourceConfig) ||
    !validateConfigObjectRaw(config).ok ||
    findLegacyConfigIssues(config, config).length > 0
  ) {
    return null;
  }

  return buildAutomaticConfigRepairPlan(snapshot, config, changes);
}

/**
 * Repairable-snapshot trust check for callers that run before startup state admission
 * (gateway pre-bootstrap selection, backup discovery). The full planner covers
 * plugin-contract migrations but reads the installed-plugin registry from the shared
 * state database; when that store is unreachable, fall back to the state-free preview
 * so core-key repairs stay reachable and everything else keeps today's fail-closed
 * refusal. The preflight committer and canonical-write matcher stay authoritative.
 */
export function resolveStartupConfigSnapshot(snapshot: ConfigFileSnapshot) {
  if (snapshot.valid) {
    return snapshot;
  }
  try {
    return planAutomaticConfigRepair(snapshot)?.snapshot;
  } catch {
    return planStartupConfigRepairPreview(snapshot)?.snapshot;
  }
}

/** Matches only the canonical writer result for a previously admitted startup repair. */
export function isStartupConfigRepairResult(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
): boolean {
  const plan = planAutomaticConfigRepair(before);
  const expected = plan
    ? stampConfigWriteMetadata(
        applyUnsetPathsForWrite(plan.config, resolveManagedUnsetPathsForWrite(undefined)),
        undefined,
        undefined,
        before.parsed,
      )
    : null;
  return Boolean(
    expected &&
    after.valid &&
    before.path === after.path &&
    isDeepStrictEqual(expected, after.sourceConfig),
  );
}

/** Commits a planned repair against the exact snapshot admitted by its caller. */
export async function commitAutomaticConfigRepair(
  plan: AutomaticConfigRepairPlan,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  await replaceConfigFile({
    nextConfig: plan.config,
    snapshot,
    afterWrite: { mode: "none", reason: "automatic migration" },
    writeOptions: {
      auditOrigin: "doctor",
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
    },
  });
}
