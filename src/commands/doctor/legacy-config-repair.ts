// Update-channel config repair for legacy config files before normal command startup.
import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { configWriteTargetsIncludeBoundary } from "../../config/mutate.js";
import { validateConfigObjectRawWithPlugins } from "../../config/validation.js";
import { containsAuthoredInclude } from "./shared/include-migration-ownership.js";
import { migrateLegacyConfig } from "./shared/legacy-config-migrate.js";

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

/** Migrate a legacy config snapshot during update, unless validation blocks it. */
export async function repairLegacyConfigForUpdateChannel(params: {
  configSnapshot: ConfigSnapshot;
  configWriteOptions: ConfigWriteOptions;
  jsonMode: boolean;
}): Promise<{ snapshot: ConfigSnapshot; repaired: boolean }> {
  const hasAuthoredIncludes = containsAuthoredInclude(params.configSnapshot.parsed);
  const migrated = migrateLegacyConfig(params.configSnapshot.sourceConfig);
  if (!migrated.config) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  const validated = validateConfigObjectRawWithPlugins(migrated.config);
  if (!validated.ok) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  const nextConfig = migrated.sourceConfig ?? migrated.config;
  if (
    hasAuthoredIncludes &&
    !configWriteTargetsIncludeBoundary({ snapshot: params.configSnapshot, nextConfig })
  ) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  await replaceConfigFile({
    sourceConfig: nextConfig,
    baseHash: params.configSnapshot.hash,
    writeOptions: {
      ...params.configWriteOptions,
      auditOrigin: "doctor",
      allowConfigSizeDrop: true,
      skipOutputLogs: params.jsonMode,
    },
  });

  const snapshot = await readConfigFileSnapshot();
  return { snapshot, repaired: snapshot.valid };
}
