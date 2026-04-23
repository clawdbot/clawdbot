import { getActivePluginRegistry } from "./runtime.js";

export const CODEX_APP_SERVER_EXTENSION_RUNTIME_ID = "codex-app-server";

export function listCodexAppServerExtensionFactories() {
  return (
    getActivePluginRegistry()?.codexAppServerExtensionFactories?.map((entry) => entry.factory) ?? []
  );
}
