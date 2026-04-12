// Public contract-safe web-search registration helpers for provider plugins.

import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import { enablePluginInConfig } from "./provider-enable-config.js";
import {
  createBaseWebSearchProviderContractFields,
  type CreateWebSearchProviderContractFieldsOptions,
} from "./provider-web-search-contract-fields.js";
export {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
export { enablePluginInConfig } from "./provider-enable-config.js";
export type {
  WebSearchCredentialResolutionSource,
  WebSearchProviderSetupContext,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
};
export type {
  CreateWebSearchProviderContractFieldsOptions,
  WebSearchProviderConfiguredCredential,
  WebSearchProviderContractCredential,
  WebSearchProviderContractFields,
} from "./provider-web-search-contract-fields.js";

type CreateWebSearchProviderSelectionOptions = CreateWebSearchProviderContractFieldsOptions & {
  selectionPluginId?: string;
};

export function createWebSearchProviderContractFields(
  options: CreateWebSearchProviderSelectionOptions,
): Pick<
  WebSearchProviderPlugin,
  "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"
> &
  Partial<
    Pick<
      WebSearchProviderPlugin,
      "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
    >
  > {
  const selectionPluginId = options.selectionPluginId;

  return {
    ...createBaseWebSearchProviderContractFields(options),
    ...(selectionPluginId
      ? {
          applySelectionConfig: (config: OpenClawConfig) =>
            enablePluginInConfig(config, selectionPluginId).config,
        }
      : {}),
  };
}
