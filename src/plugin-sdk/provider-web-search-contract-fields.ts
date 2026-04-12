import type { SearchConfigRecord } from "../agents/tools/web-search-provider-common.js";
import {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WebSearchProviderPlugin } from "../plugins/types.js";

export type WebSearchProviderContractCredential =
  | { type: "none" }
  | { type: "top-level" }
  | { type: "scoped"; scopeId: string };

export type WebSearchProviderConfiguredCredential = {
  pluginId: string;
  field?: string;
};

export type CreateWebSearchProviderContractFieldsOptions = {
  credentialPath: string;
  inactiveSecretPaths?: string[];
  searchCredential: WebSearchProviderContractCredential;
  configuredCredential?: WebSearchProviderConfiguredCredential;
};

export type WebSearchProviderContractFields = Pick<
  WebSearchProviderPlugin,
  "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"
> &
  Partial<
    Pick<WebSearchProviderPlugin, "getConfiguredCredentialValue" | "setConfiguredCredentialValue">
  >;

function createSearchCredentialFields(
  credential: WebSearchProviderContractCredential,
): Pick<WebSearchProviderPlugin, "getCredentialValue" | "setCredentialValue"> {
  switch (credential.type) {
    case "scoped":
      return {
        getCredentialValue: (searchConfig?: SearchConfigRecord) =>
          getScopedCredentialValue(searchConfig, credential.scopeId),
        setCredentialValue: (searchConfigTarget: SearchConfigRecord, value: unknown) =>
          setScopedCredentialValue(searchConfigTarget, credential.scopeId, value),
      };
    case "top-level":
      return {
        getCredentialValue: getTopLevelCredentialValue,
        setCredentialValue: setTopLevelCredentialValue,
      };
    case "none":
      return {
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
      };
  }
  throw new Error("Unsupported web search credential type");
}

function createConfiguredCredentialFields(
  configuredCredential?: WebSearchProviderConfiguredCredential,
): Pick<
  WebSearchProviderPlugin,
  "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
> | null {
  if (!configuredCredential) {
    return null;
  }

  const field = configuredCredential.field ?? "apiKey";

  return {
    getConfiguredCredentialValue: (config?: OpenClawConfig) =>
      resolveProviderWebSearchPluginConfig(config, configuredCredential.pluginId)?.[field],
    setConfiguredCredentialValue: (configTarget: OpenClawConfig, value: unknown) => {
      setProviderWebSearchPluginConfigValue(
        configTarget,
        configuredCredential.pluginId,
        field,
        value,
      );
    },
  };
}

export function createBaseWebSearchProviderContractFields(
  options: CreateWebSearchProviderContractFieldsOptions,
): WebSearchProviderContractFields {
  const configuredCredentialFields = createConfiguredCredentialFields(options.configuredCredential);

  return {
    inactiveSecretPaths:
      options.inactiveSecretPaths ?? (options.credentialPath ? [options.credentialPath] : []),
    ...createSearchCredentialFields(options.searchCredential),
    ...configuredCredentialFields,
  };
}
