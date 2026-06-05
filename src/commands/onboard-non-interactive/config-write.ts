/**
 * Config write commit helper for non-interactive onboarding.
 *
 * It preserves pending plugin install records before replacing the user config,
 * which lets setup reruns avoid dropping plugin-owned state accidentally.
 */
import {
  commitConfigWriteWithPendingPluginInstalls,
  hasPendingPluginInstallRecords,
  stripPendingPluginInstallRecords,
  unchangedPendingPluginInstallRecordIds,
} from "../../cli/plugins-install-record-commit.js";
import { replaceConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Commits a non-interactive onboard config update with pending plugin records handled first. */
export async function commitNonInteractiveOnboardConfig(params: {
  nextConfig: OpenClawConfig;
  baseConfig: OpenClawConfig;
  baseHash?: string;
  reset?: boolean;
}): Promise<OpenClawConfig> {
  // Ordinary onboard reruns must preserve existing agents.list / bindings.
  // Only explicit --reset may allow a config size drop; see openclaw#84692.
  const allowConfigSizeDrop = params.reset === true;
  let writeBaseHash = params.baseHash;
  let nextConfig = params.nextConfig;
  if (!allowConfigSizeDrop && hasPendingPluginInstallRecords(params.baseConfig)) {
    // Pending install records are persisted against the old config first so the
    // later onboard write can use the fresh hash and keep optimistic locking.
    const migrated = await commitConfigWriteWithPendingPluginInstalls({
      nextConfig: params.baseConfig,
      writeOptions: { allowConfigSizeDrop: true },
      commit: async (config, writeOptions) => {
        return await replaceConfigFile({
          nextConfig: config,
          ...(writeBaseHash !== undefined ? { baseHash: writeBaseHash } : {}),
          ...(writeOptions ? { writeOptions } : {}),
        });
      },
    });
    writeBaseHash = migrated.persistedHash ?? undefined;
    // If onboard did not change a pending record, strip it from the next write;
    // the migration above has already committed the durable version.
    nextConfig = stripPendingPluginInstallRecords(
      nextConfig,
      unchangedPendingPluginInstallRecordIds(nextConfig, params.baseConfig),
    );
  }
  const committed = await commitConfigWriteWithPendingPluginInstalls({
    nextConfig,
    writeOptions: { allowConfigSizeDrop },
    commit: async (config, writeOptions) => {
      return await replaceConfigFile({
        nextConfig: config,
        ...(writeBaseHash !== undefined ? { baseHash: writeBaseHash } : {}),
        ...(writeOptions ? { writeOptions } : {}),
      });
    },
  });
  return committed.config;
}
