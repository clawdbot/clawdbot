/**
 * Public SDK type surface for plugin-declared secret provider integrations.
 */
export type { PluginManifestSecretProviderIntegration } from "../plugins/manifest.js";
export type {
  SecretProviderIntegrationPreset,
  SecretProviderIntegrationResolution,
} from "../secrets/provider-integrations.js";
export type { PluginIntegrationSecretProviderConfig } from "../config/types.secrets.js";
