import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import { INCLUDE_KEY } from "../../config/includes.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
import { isRecord } from "../../utils.js";
import { migrateLegacyConfig } from "./shared/legacy-config-migrate.js";

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

function containsAuthoredInclude(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, INCLUDE_KEY)) {
    return true;
  }
  return Object.values(value).some((entry) => containsAuthoredInclude(entry));
}

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
      allowConfigSizeDrop: true,
      skipOutputLogs: params.jsonMode,
    },
  });

  const snapshot = await readConfigFileSnapshot();
  return { snapshot, repaired: snapshot.valid };
}
