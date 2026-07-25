import type {
  ConfigMutationPreflight,
  ConfigSnapshotForInstallPersist,
} from "../plugins/install-persistence.js";
import type { PluginInstallRequestContext } from "./plugin-install-config-policy.js";
import "./plugins-install-command.js";

type ConfigSnapshotForInstallExecution = ConfigSnapshotForInstallPersist & {
  hookMutation: ConfigMutationPreflight;
  pluginMutation: ConfigMutationPreflight;
};

type PluginsInstallCommandTestApi = {
  loadConfigForInstall(
    request: PluginInstallRequestContext,
  ): Promise<ConfigSnapshotForInstallExecution>;
};

function getTestApi(): PluginsInstallCommandTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.pluginsInstallCommandTestApi")
  ] as PluginsInstallCommandTestApi;
}

export async function loadConfigForInstall(
  request: PluginInstallRequestContext,
): Promise<ConfigSnapshotForInstallExecution> {
  return await getTestApi().loadConfigForInstall(request);
}
