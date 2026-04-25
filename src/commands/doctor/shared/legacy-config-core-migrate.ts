import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { migrateLegacySecretRefEnvMarkers } from "../../../secrets/legacy-secretref-env-marker.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { normalizeBaseCompatibilityConfigValues } from "./legacy-config-compatibility-base.js";
import {
  normalizeLegacyCommandsConfig,
  normalizeLegacyOpenAICodexModelsAddMetadata,
} from "./legacy-config-core-normalizers.js";

export function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next = normalizeBaseCompatibilityConfigValues(cfg, changes, (config) => {
    const setupMigration = runPluginSetupConfigMigrations({
      config,
    });
    if (setupMigration.changes.length === 0) {
      return config;
    }
    changes.push(...setupMigration.changes);
    return setupMigration.config;
  });
  const channelMigrations = applyChannelDoctorCompatibilityMigrations(next);
  if (channelMigrations.changes.length > 0) {
    next = channelMigrations.next;
    changes.push(...channelMigrations.changes);
  }
  const secretRefMarkers = migrateLegacySecretRefEnvMarkers(next);
  if (secretRefMarkers.changes.length > 0) {
    next = secretRefMarkers.config;
    changes.push(...secretRefMarkers.changes);
  }
  next = normalizeLegacyCommandsConfig(next, changes);
  next = normalizeLegacyOpenAICodexModelsAddMetadata(next, changes);

  return { config: next, changes };
}
