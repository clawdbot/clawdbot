// Codex runtime plugin auto-install/repair helpers for OpenAI model selections.
import { modelSelectionShouldEnsureCodexPlugin } from "../agents/openai-routing.js";
import { createRuntimePluginModelSelectionHelpers } from "./runtime-plugin-install.js";

export const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";
const CODEX_RUNTIME_PLUGIN_DESCRIPTOR = {
  pluginId: CODEX_RUNTIME_PLUGIN_ID,
  label: CODEX_RUNTIME_PLUGIN_LABEL,
  npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC,
  warningLabel: CODEX_RUNTIME_PLUGIN_LABEL,
};

const codexRuntimePluginInstall = createRuntimePluginModelSelectionHelpers({
  descriptor: CODEX_RUNTIME_PLUGIN_DESCRIPTOR,
  shouldEnsure: ({ cfg, model, agentId }) =>
    modelSelectionShouldEnsureCodexPlugin({
      config: cfg,
      model,
      agentId,
    }),
});

const codexSupervisionPluginInstall = createRuntimePluginModelSelectionHelpers({
  descriptor: CODEX_RUNTIME_PLUGIN_DESCRIPTOR,
  shouldEnsure: () => true,
});

export const ensureCodexRuntimePluginForModelSelection = codexRuntimePluginInstall.ensure;
export const repairCodexRuntimePluginInstallForModelSelection = codexRuntimePluginInstall.repair;
export const ensureCodexRuntimePluginForSupervision = codexSupervisionPluginInstall.ensure;
