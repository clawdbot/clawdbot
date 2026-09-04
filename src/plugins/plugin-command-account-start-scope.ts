import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type PluginCommandAccountStartScope = Readonly<{
  channelId: string;
  retainCatalog: () => void;
}>;

const PLUGIN_COMMAND_ACCOUNT_START_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginCommandAccountStartScope",
);

const pluginCommandAccountStartScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginCommandAccountStartScope>
>(
  PLUGIN_COMMAND_ACCOUNT_START_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginCommandAccountStartScope>(),
);

/** Runs one channel account startup lifetime with its catalog-retention owner. */
export function withPluginCommandAccountStartScope<T>(
  scope: PluginCommandAccountStartScope,
  run: () => T,
): T {
  return pluginCommandAccountStartScope.run(scope, run);
}

/** Marks the current account only when its startup channel matches the catalog provider. */
export function retainPluginCommandCatalogForCurrentAccount(channelId: string): void {
  const scope = pluginCommandAccountStartScope.getStore();
  if (scope?.channelId === channelId) {
    scope.retainCatalog();
  }
}
