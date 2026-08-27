/** Runtime dependency bundle for provider/model picker flows. */
import {
  resolveProviderModelPickerFlowContributions,
  resolveProviderModelPickerFlowEntries,
} from "../flows/provider-flow.runtime.js";
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import {
  resolveProviderPluginChoiceCore,
  runProviderModelSelectedHookCore,
} from "../plugins/provider-wizard.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";

/** Lazy runtime methods consumed by model picker command flows. */
export const modelPickerRuntime = {
  resolveProviderModelPickerContributions: resolveProviderModelPickerFlowContributions,
  resolveProviderModelPickerEntries: resolveProviderModelPickerFlowEntries,
  resolveProviderPluginChoice: resolveProviderPluginChoiceCore,
  runProviderModelSelectedHook: runProviderModelSelectedHookCore,
  resolvePluginProviders: resolvePluginProvidersCore,
  runProviderPluginAuthMethod,
};
