import { isDeepStrictEqual } from "node:util";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "../../../config/config-path-mutation.js";
import { resolveConfigSnapshotHash, transformConfigFile } from "../../../config/config.js";
import { stampConfigWriteMetadata } from "../../../config/io.meta.js";
import { containsConfigIncludeDirective } from "../../../config/io.read-helpers.js";
import { prepareConfigWriteTopology } from "../../../config/io.write-topology.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectWithPlugins,
} from "../../../config/validation.js";
import { restoreDoctorConfigEnvRefs } from "./config-flow-steps.js";
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

function prepareAutomaticConfigRepairWrite(snapshot: ConfigFileSnapshot, config: OpenClawConfig) {
  const unsetPaths = resolveManagedUnsetPathsForWrite(undefined);
  return stampConfigWriteMetadata(
    applyUnsetPathsForWrite(
      prepareConfigWriteTopology({
        snapshot,
        nextConfig: config,
        options: { persistCanonicalAgentRoster: true },
        unsetPaths,
        env: process.env,
      }).nextConfig,
      unsetPaths,
    ),
    undefined,
    undefined,
    snapshot.parsed,
  );
}

function planConfigRepair(
  snapshot: ConfigFileSnapshot,
  pluginContracts: boolean,
): AutomaticConfigRepairPlan | null {
  if (!admitAutomaticConfigRepairSnapshot(snapshot)) {
    return null;
  }
  const { next: config, changes } = applyLegacyDoctorMigrations(
    snapshot.sourceConfig,
    { authoredRaw: snapshot.parsed, resolvedRaw: snapshot.sourceConfig },
    { pluginContracts },
  );
  if (!config || isDeepStrictEqual(config, snapshot.sourceConfig)) {
    return null;
  }
  const valid = pluginContracts
    ? validateConfigObjectWithPlugins(prepareAutomaticConfigRepairWrite(snapshot, config)).ok
    : validateConfigObjectRaw(config).ok;
  const issues = (pluginContracts ? findDoctorLegacyConfigIssues : findLegacyConfigIssues)(
    config,
    config,
  );
  if (!valid || issues.length > 0) {
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

/** Admits only complete, deterministic single-file legacy migrations. */
export function planAutomaticConfigRepair(
  snapshot: ConfigFileSnapshot,
): AutomaticConfigRepairPlan | null {
  return planConfigRepair(snapshot, true);
}

/**
 * Pre-bootstrap selection must not open state while deciding whether startup is safe.
 * Full plugin-contract validation belongs to the admitted preflight's repair plan.
 */
export function resolveStartupConfigSnapshot(snapshot: ConfigFileSnapshot) {
  if (snapshot.valid) {
    return snapshot;
  }
  return planConfigRepair(snapshot, false)?.snapshot;
}

/** Matches only the canonical writer result for a previously admitted startup repair. */
export function isStartupConfigRepairResult(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
): boolean {
  const plan = planAutomaticConfigRepair(before);
  const expected = plan ? prepareAutomaticConfigRepairWrite(before, plan.config) : null;
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
  await transformConfigFile({
    baseHash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    // Preflight can commit before the later Doctor health write. Preserve moved
    // references here, under the same snapshot/hash and read-time environment.
    transform: (_current, { snapshot: currentSnapshot }, { envSnapshotForRestore }) => ({
      nextConfig: restoreDoctorConfigEnvRefs(plan.config, currentSnapshot, envSnapshotForRestore),
    }),
    afterWrite: { mode: "none", reason: "automatic migration" },
    writeOptions: {
      expectedConfigPath: snapshot.path,
      auditOrigin: "doctor",
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
      // The reader retired legacy markers; persist their canonical owners in this write.
      // Startup verification above uses the same writer topology preparation.
      persistCanonicalAgentRoster: true,
    },
  });
}
