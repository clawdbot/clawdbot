// Update-channel config repair for legacy config files before normal command startup.
import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import { INCLUDE_KEY } from "../../config/includes.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
import { isRecord } from "../../utils.js";
import { migrateLegacyConfig } from "./shared/legacy-config-migrate.js";

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

/** Return true when a config tree uses authored includes that doctor must not flatten. */
function containsAuthoredInclude(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, INCLUDE_KEY)) {
    return true;
  }
  return Object.values(value).some((entry) => containsAuthoredInclude(entry));
}

/** Migrate a legacy config snapshot during update, unless includes or validation block it. */
export async function repairLegacyConfigForUpdateChannel(params: {
  configSnapshot: ConfigSnapshot;
  jsonMode: boolean;
}): Promise<{ snapshot: ConfigSnapshot; repaired: boolean }> {
  if (containsAuthoredInclude(params.configSnapshot.parsed)) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  const migrated = migrateLegacyConfig(params.configSnapshot.parsed);
  if (!migrated.config) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  const validated = validateConfigObjectWithPlugins(migrated.config);
  if (!validated.ok) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  await replaceConfigFile({
    nextConfig: validated.config,
    baseHash: params.configSnapshot.hash,
    writeOptions: {
      auditOrigin: "doctor",
      allowConfigSizeDrop: true,
      skipOutputLogs: params.jsonMode,
    },
  });

  const snapshot = await readConfigFileSnapshot();
  return { snapshot, repaired: snapshot.valid };
}
