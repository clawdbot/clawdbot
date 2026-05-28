import { resolveProviderPluginChoice } from "../../../plugins/provider-wizard.js";
import { resolveOwningPluginIdsForProviderRef } from "../../../plugins/providers.js";
import { resolvePluginProviders } from "../../../plugins/providers.runtime.js";

export const authChoicePluginProvidersRuntime = {
  resolveOwningPluginIdsForProviderRef,
  resolveProviderPluginChoice,
  resolvePluginProviders,
};
