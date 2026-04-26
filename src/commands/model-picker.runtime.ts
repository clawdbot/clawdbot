import {
  resolveProviderModelPickerFlowContributions,
  resolveProviderModelPickerFlowEntries,
} from "../flows/provider-flow.runtime.js";
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import {
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
} from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";

export const modelPickerRuntime = {
  resolveProviderModelPickerContributions: resolveProviderModelPickerFlowContributions,
  resolveProviderModelPickerEntries: resolveProviderModelPickerFlowEntries,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
  resolvePluginProviders,
  runProviderPluginAuthMethod,
};
