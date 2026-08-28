import { isDeepStrictEqual } from "node:util";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "../../../config/config-path-mutation.js";
import { replaceConfigFile } from "../../../config/config.js";
import { stampConfigWriteMetadata } from "../../../config/io.meta.js";
import { containsConfigIncludeDirective } from "../../../config/io.read-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";

type StartupConfigRepairPlan = {
  config: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  changes: string[];
};

/** Admits only complete, deterministic single-file legacy migrations for startup. */
export function planStartupConfigRepair(
  snapshot: ConfigFileSnapshot,
): StartupConfigRepairPlan | null {
  if (
    snapshot.valid ||
    !snapshot.exists ||
    snapshot.raw === null ||
    (snapshot.includedPaths?.length ?? 0) > 0 ||
    containsConfigIncludeDirective(snapshot.parsed)
  ) {
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

export function resolveStartupConfigSnapshot(snapshot: ConfigFileSnapshot) {
  return snapshot.valid ? snapshot : planStartupConfigRepair(snapshot)?.snapshot;
}

/** Matches only the canonical writer result for a previously admitted startup repair. */
export function isStartupConfigRepairResult(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
): boolean {
  const plan = planStartupConfigRepair(before);
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

/** Commits a planned repair against the exact snapshot admitted under the startup lease. */
export async function commitStartupConfigRepair(
  plan: StartupConfigRepairPlan,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  await replaceConfigFile({
    nextConfig: plan.config,
    snapshot,
    afterWrite: { mode: "none", reason: "startup migration" },
    writeOptions: {
      auditOrigin: "doctor",
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
    },
  });
}
