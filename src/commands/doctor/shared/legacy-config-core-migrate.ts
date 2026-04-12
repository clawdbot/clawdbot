import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { collectChannelDoctorCompatibilityMutations } from "./channel-doctor.js";
import {
  normalizeLegacyBrowserConfig,
  normalizeLegacyCrossContextMessageConfig,
  normalizeLegacyMediaProviderOptions,
  normalizeLegacyMistralModelMaxTokens,
  normalizeLegacyNanoBananaSkill,
  normalizeLegacyTalkConfig,
  seedMissingDefaultAccountsFromSingleAccountBase,
} from "./legacy-config-core-normalizers.js";
import { migrateLegacyWebFetchConfig } from "./legacy-web-fetch-migrate.js";
import { migrateLegacyWebSearchConfig } from "./legacy-web-search-migrate.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

export function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next = seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes);
  next = normalizeLegacyBrowserConfig(next, changes);

  const setupMigration = runPluginSetupConfigMigrations({
    config: next,
  });
  if (setupMigration.changes.length > 0) {
    next = setupMigration.config;
    changes.push(...setupMigration.changes);
  }

  for (const migrate of [
    migrateLegacyWebSearchConfig,
    migrateLegacyWebFetchConfig,
    migrateLegacyXSearchConfig,
  ]) {
    const migrated = migrate(next);
    if (migrated.changes.length === 0) {
      continue;
    }
    next = migrated.config;
    changes.push(...migrated.changes);
  }

  next = normalizeLegacyNanoBananaSkill(next, changes);
  next = normalizeLegacyTalkConfig(next, changes);
  next = normalizeLegacyCrossContextMessageConfig(next, changes);
  next = normalizeLegacyMediaProviderOptions(next, changes);
  next = normalizeLegacyMistralModelMaxTokens(next, changes);
  for (const mutation of collectChannelDoctorCompatibilityMutations(next)) {
    if (mutation.changes.length === 0) {
      continue;
    }
    next = mutation.config;
    changes.push(...mutation.changes);
  }

  return { config: next, changes };
}
