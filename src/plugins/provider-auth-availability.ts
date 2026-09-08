import { nativePluginBindings } from "./loader-runtime-load.js";
export const {
  isProviderApiKeyConfigured,
  listUsableProviderAuthProfileIds,
  isProviderAuthProfileConfigured,
  resolveProviderAuthProfileApiKey,
} = nativePluginBindings.authAvailability;
