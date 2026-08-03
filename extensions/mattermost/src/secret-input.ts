// Mattermost plugin module implements secret input behavior.
export type { SecretInput } from "openclaw/plugin-sdk/secret-input";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
export type { SecretInputStringResolutionMode } from "openclaw/plugin-sdk/secret-input";
