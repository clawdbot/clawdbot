// Gateway-owned full migration completion after the plugin-free CLI config guard.
import type { ConfigFileSnapshot } from "../../config/types.js";

export async function runGatewayStartupMigrations(params: {
  beforeStateMigrations: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
}): Promise<void> {
  const { runDoctorConfigPreflight } = await import("../../commands/doctor-config-preflight.js");
  await runDoctorConfigPreflight({
    migrateState: true,
    migrateLegacyConfig: false,
    invalidConfigNote: false,
    requireStartupMigrationCheckpoint: true,
    pluginRuntime: "full",
    beforeStateMigrations: params.beforeStateMigrations,
  });
}
