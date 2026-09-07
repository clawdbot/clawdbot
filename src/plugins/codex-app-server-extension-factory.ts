// Builds Codex app-server extension factories from active plugin registries.
import { getActivePluginRegistry } from "./runtime.js";

/** Runtime id used by Codex app-server extension factories. */
export const CODEX_APP_SERVER_EXTENSION_RUNTIME_ID = "codex-app-server";

/** Lists active Codex app-server extension factories from the plugin registry. */
export function listCodexAppServerExtensionFactories() {
  return (
    getActivePluginRegistry()?.codexAppServerExtensionFactories?.map((entry) => entry.factory) ?? []
  );
}
