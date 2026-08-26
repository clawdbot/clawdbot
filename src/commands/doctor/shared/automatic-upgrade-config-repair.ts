import { isDeepStrictEqual } from "node:util";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "../../../config/config-path-mutation.js";
import { replaceConfigFile } from "../../../config/config.js";
import { stampConfigWriteMetadata } from "../../../config/io.meta.js";
import { containsConfigIncludeDirective } from "../../../config/io.read-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";

// Stable 2026.7.1-2 authored these keys immediately before main retired them. Keep this
// compatibility set exact: widening it would turn Gateway startup into a general doctor repair.
const AUTOMATIC_UPGRADE_CONFIG_UNSET_PATHS: string[][] = [
  ["meta", "lastTouchedAt"],
  ["agents", "defaults", "heartbeat", "skipWhenBusy"],
];

const AUTOMATIC_UPGRADE_CONFIG_ISSUE_PATHS = new Set(["meta", "agents.defaults.heartbeat"]);

type UpgradeConfigRepairPlan = {
  config: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  unsetPaths: string[][];
};

/** Plans the one tagged stable-to-main config repair that is safe before full validation. */
export function planUpgradeConfigRepair(
  snapshot: ConfigFileSnapshot,
): UpgradeConfigRepairPlan | null {
  if (
    snapshot.valid ||
    !snapshot.exists ||
    snapshot.raw === null ||
    snapshot.issues.length === 0 ||
    snapshot.issues.some((issue) => !AUTOMATIC_UPGRADE_CONFIG_ISSUE_PATHS.has(issue.path)) ||
    snapshot.legacyIssues.some((issue) => issue.path !== "") ||
    (snapshot.includedPaths?.length ?? 0) > 0 ||
    containsConfigIncludeDirective(snapshot.parsed)
  ) {
    return null;
  }

  const unsetPaths = AUTOMATIC_UPGRADE_CONFIG_UNSET_PATHS;
  const config = applyUnsetPathsForWrite(snapshot.sourceConfig, unsetPaths);
  if (
    isDeepStrictEqual(config, snapshot.sourceConfig) ||
    !validateConfigObjectRaw(config).ok ||
    findDoctorLegacyConfigIssues(config, config).length > 0
  ) {
    return null;
  }

  return {
    config,
    unsetPaths,
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

export function resolveUpgradeConfigSnapshot(snapshot: ConfigFileSnapshot) {
  return snapshot.valid ? snapshot : planUpgradeConfigRepair(snapshot)?.snapshot;
}

/** Matches only the canonical writer result for a previously admitted upgrade repair. */
export function isUpgradeConfigRepairResult(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
): boolean {
  const plan = planUpgradeConfigRepair(before);
  const expected = plan
    ? stampConfigWriteMetadata(
        applyUnsetPathsForWrite(plan.config, resolveManagedUnsetPathsForWrite(plan.unsetPaths)),
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

/** Commits a planned repair against the exact snapshot admitted under the startup lease. */
export async function commitUpgradeConfigRepair(
  plan: UpgradeConfigRepairPlan,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  await replaceConfigFile({
    nextConfig: plan.config,
    snapshot,
    afterWrite: { mode: "none", reason: "startup migration" },
    writeOptions: {
      auditOrigin: "doctor",
      unsetPaths: plan.unsetPaths,
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
    },
  });
}
