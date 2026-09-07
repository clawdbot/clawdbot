import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

export const POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON = "post-plugin-doctor-execution-failed";

export function applyPostPluginConfigValidation(
  pluginUpdate: PostCorePluginUpdateResult,
  configValid: boolean,
): PostCorePluginUpdateResult {
  if (
    configValid ||
    (pluginUpdate.status === "error" &&
      pluginUpdate.reason !== POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON)
  ) {
    return pluginUpdate;
  }
  return {
    ...pluginUpdate,
    status: "error",
    reason: "post-plugin-doctor-invalid-config",
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason: "Config remained invalid after updated plugin migrations.",
        message:
          "Post-update plugin migration did not produce a valid config; refusing to restart.",
        guidance: ["Run `openclaw doctor --fix`, then rerun `openclaw update repair`."],
      },
    ],
  };
}
