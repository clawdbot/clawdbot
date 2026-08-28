import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

/** Read failures must escape before either projection can authorize recovery or rebuilding. */
export function readPersistedInstalledPluginIndexRowSync(
  options: InstalledPluginIndexStoreOptions,
): { value_json: string } | undefined {
  if (options.filePath?.endsWith(".json")) {
    return undefined;
  }
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "config_machine_state")) {
      return undefined;
    }
    return (
      db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        // SAFETY: config_machine_state.value_json is TEXT NOT NULL under STRICT.
        .get("plugins.installedIndex") as { value_json: string } | undefined
    );
  }, resolveInstalledPluginIndexStateDatabaseOptions(options));
}
