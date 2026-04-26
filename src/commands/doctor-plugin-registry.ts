import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndexRecordStoreOptions } from "../plugins/installed-plugin-index-records.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
  type PluginRegistryInstallMigrationParams,
} from "./doctor/shared/plugin-registry-migration.js";

type PluginRegistryDoctorRepairParams = Omit<PluginRegistryInstallMigrationParams, "config"> &
  InstalledPluginIndexRecordStoreOptions & {
    config: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "shouldRepair">;
  };

export async function maybeRepairPluginRegistryState(
  params: PluginRegistryDoctorRepairParams,
): Promise<OpenClawConfig> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  for (const warning of preflight.deprecationWarnings) {
    note(warning, "Plugin registry");
  }
  if (preflight.action === "disabled") {
    note(
      `${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`,
      "Plugin registry",
    );
    return params.config;
  }

  const migrationParams = {
    ...params,
    config: params.config,
  };
  if (!params.prompter.shouldRepair) {
    if (preflight.action === "migrate") {
      note(
        [
          "Persisted plugin registry is missing or stale.",
          `Repair with ${formatCliCommand("openclaw doctor --fix")} to rebuild ${shortenHomePath(preflight.filePath)} from enabled plugins.`,
        ].join("\n"),
        "Plugin registry",
      );
    }
    return params.config;
  }

  if (preflight.action === "migrate") {
    const result = await migratePluginRegistryForInstall(migrationParams);
    if (result.migrated) {
      const total = result.current.plugins.length;
      const enabled = result.current.plugins.filter((plugin) => plugin.enabled).length;
      note(
        `Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`,
        "Plugin registry",
      );
    }
    return params.config;
  }

  if (preflight.action === "skip-existing") {
    const index = await refreshPluginRegistry({
      ...migrationParams,
      reason: "migration",
    });
    const total = index.plugins.length;
    const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
    note(
      `Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`,
      "Plugin registry",
    );
  }

  return params.config;
}
