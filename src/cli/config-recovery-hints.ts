// Reusable recovery strings for config/startup failures surfaced by CLI commands.
import { formatCliCommand } from "./command-format.js";

/** Hint shown when doctor can migrate or repair an invalid config file. */
export function formatInvalidConfigRecoveryHint(): string {
  return [
    `Run "${formatCliCommand("openclaw doctor --fix")}" to repair, then retry.`,
    "If startup is still blocked, inspect the adjacent .bak backup before restoring it manually.",
  ].join("\n");
}

/** Hint shown when a plugin package is missing its compiled runtime output. */
export function formatPluginPackagingRuntimeOutputRecoveryHint(): string {
  return [
    "This is a plugin packaging issue, not a local config problem.",
    "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
  ].join("\n");
}
