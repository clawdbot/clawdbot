import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { PluginRecord } from "../plugins/registry.js";

export const CUSTOM_PLUGIN_UI_DISABLED_MESSAGE =
  "Custom plugin UI is disabled. Enable Custom plugin UI in Settings > Labs, restart the Gateway, and reload this page.";

export function isControlUiPluginAllowed(plugin: Pick<PluginRecord, "origin">): boolean {
  // Bundled provenance comes from the loader, never the plugin manifest. Read
  // the applied snapshot so request-time admission does not reload config.
  return (
    plugin.origin === "bundled" ||
    getRuntimeConfigSnapshot()?.gateway?.controlUi?.experimental?.customPlugins === true
  );
}
