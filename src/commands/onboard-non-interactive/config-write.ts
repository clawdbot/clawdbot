import {
  commitConfigWriteWithPendingPluginInstalls,
  hasPendingPluginInstallRecords,
  stripPendingPluginInstallRecords,
  unchangedPendingPluginInstallRecordIds,
} from "../../cli/plugins-install-record-commit.js";
import { replaceConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

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
