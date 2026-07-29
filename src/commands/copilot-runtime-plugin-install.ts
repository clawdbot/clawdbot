// GitHub Copilot runtime plugin auto-install/repair helpers for model selections.
import { modelSelectionShouldEnsureCopilotRuntimePlugin } from "../agents/copilot-routing.js";
import { createRuntimePluginModelSelectionHelpers } from "./runtime-plugin-install.js";

const COPILOT_RUNTIME_PLUGIN_ID = "copilot";
const COPILOT_RUNTIME_PLUGIN_LABEL = "GitHub Copilot agent runtime";
const COPILOT_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/copilot";
const COPILOT_RUNTIME_PLUGIN_DESCRIPTOR = {
  pluginId: COPILOT_RUNTIME_PLUGIN_ID,
  label: COPILOT_RUNTIME_PLUGIN_LABEL,
  npmSpec: COPILOT_RUNTIME_PLUGIN_NPM_SPEC,
  warningLabel: "GitHub Copilot",
};

const copilotRuntimePluginInstall = createRuntimePluginModelSelectionHelpers({
  descriptor: COPILOT_RUNTIME_PLUGIN_DESCRIPTOR,
  shouldEnsure: ({ cfg, model }) =>
    modelSelectionShouldEnsureCopilotRuntimePlugin({
      config: cfg,
      model,
    }),
});

export const ensureCopilotRuntimePluginForModelSelection = copilotRuntimePluginInstall.ensure;
export const repairCopilotRuntimePluginInstallForModelSelection =
  copilotRuntimePluginInstall.repair;
