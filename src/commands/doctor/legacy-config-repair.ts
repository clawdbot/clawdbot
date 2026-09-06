// Update-channel config repair for legacy config files before normal command startup.
import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObjectRawWithPlugins } from "../../config/validation.js";
import {
  containsAuthoredInclude,
  isSingleTopLevelIncludeMigration,
} from "./shared/include-migration-ownership.js";
import { migrateLegacyConfig } from "./shared/legacy-config-migrate.js";

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

export type LegacyConfigUpdatePlan = {
  snapshot: ConfigSnapshot;
  config: OpenClawConfig;
  nextConfig: OpenClawConfig;
  includeIdentity: Pick<
    ConfigWriteOptions,
    "includeFileHashesForWrite" | "includeFileTargetsForWrite"
  >;
};

/** Plan without replacing the source: update checkpoints must retain the authored bytes. */
export function planLegacyConfigForUpdateChannel(
  configSnapshot: ConfigSnapshot,
  includeIdentity: LegacyConfigUpdatePlan["includeIdentity"] = {},
): LegacyConfigUpdatePlan | undefined {
  const hasAuthoredIncludes = containsAuthoredInclude(configSnapshot.parsed);
  const migrated = migrateLegacyConfig(configSnapshot.sourceConfig);
  if (!migrated.config) {
    return undefined;
  }

  const validated = validateConfigObjectRawWithPlugins(migrated.config);
  if (!validated.ok) {
    return undefined;
  }

  const nextConfig =
    hasAuthoredIncludes && migrated.sourceConfig ? migrated.sourceConfig : validated.config;
  if (
    hasAuthoredIncludes &&
    !isSingleTopLevelIncludeMigration({
      parsed: configSnapshot.parsed,
      sourceConfig: configSnapshot.sourceConfig,
      candidate: nextConfig,
    })
  ) {
    return undefined;
  }

  return {
    snapshot: configSnapshot,
    config: validated.config,
    nextConfig,
    // Snapshot-for-write exposes canonical hashes/targets without performing a write.
    // Only these data fields cross admission, never its live writer callbacks.
    includeIdentity: {
      includeFileHashesForWrite: { ...includeIdentity.includeFileHashesForWrite },
      includeFileTargetsForWrite: { ...includeIdentity.includeFileTargetsForWrite },
    },
  };
}

/**
 * Persist the prepared migration without rebasing it onto later source edits.
 * Deferred callers seal/bind their checkpoint before invoking this writer;
 * the plan itself is source data, not proof of exclusion or write authority.
 */
export async function repairLegacyConfigForUpdateChannel(params: {
  configSnapshot: ConfigSnapshot;
  plan?: LegacyConfigUpdatePlan;
  jsonMode: boolean;
}): Promise<{ snapshot: ConfigSnapshot; repaired: boolean }> {
  const plan = params.plan ?? planLegacyConfigForUpdateChannel(params.configSnapshot);
  if (!plan) {
    return { snapshot: params.configSnapshot, repaired: false };
  }
  if (params.plan && containsAuthoredInclude(plan.snapshot.parsed)) {
    const paths = plan.snapshot.includedPaths ?? [];
    if (
      paths.length === 0 ||
      paths.some(
        (includePath) =>
          !plan.includeIdentity.includeFileHashesForWrite?.[includePath] ||
          !plan.includeIdentity.includeFileTargetsForWrite?.[includePath],
      )
    ) {
      throw new Error("Legacy config plan is missing include write identities.");
    }
  }
  await replaceConfigFile({
    nextConfig: plan.nextConfig,
    baseHash: plan.snapshot.hash,
    writeOptions: {
      // Reuse the canonical writer's fresh lock/path check and original include fences.
      // Immediate repair still uses its fresh writer snapshot; deferred plans must
      // supply the data captured by readConfigFileSnapshotForWrite at planning time.
      ...(params.plan ? plan.includeIdentity : {}),
      expectedConfigPath: plan.snapshot.path,
      auditOrigin: "doctor",
      allowConfigSizeDrop: true,
      skipOutputLogs: params.jsonMode,
    },
  });

  const snapshot = await readConfigFileSnapshot();
  return { snapshot, repaired: snapshot.valid };
}
