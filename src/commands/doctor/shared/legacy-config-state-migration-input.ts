import type { ConfigFileSnapshot } from "../../../config/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

type StateMigrationConfigInput = {
  cfg?: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
};

export function resolveStateMigrationConfigInput(params: {
  snapshot: ConfigFileSnapshot;
  baseConfig: OpenClawConfig;
}): StateMigrationConfigInput | null {
  const pluginDoctorConfig = (params.snapshot.sourceConfig ??
    params.snapshot.config ??
    params.snapshot.parsed) as OpenClawConfig | undefined;
  if (params.snapshot.valid) {
    return params.snapshot.legacyIssues.length > 0 && pluginDoctorConfig !== undefined
      ? { cfg: params.baseConfig, pluginDoctorConfig }
      : { cfg: params.baseConfig };
  }
  const migrationSource = pluginDoctorConfig ?? params.snapshot.parsed;
  if (params.snapshot.legacyIssues.length === 0 || migrationSource === undefined) {
    return null;
  }
  const migrated = migrateLegacyConfig(migrationSource);
  if (!migrated.config) {
    return null;
  }
  if (migrated.partiallyValid) {
    return {
      pluginDoctorConfig: (pluginDoctorConfig ?? migrationSource) as OpenClawConfig,
    };
  }
  return {
    cfg: migrated.config,
    ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
  };
}
