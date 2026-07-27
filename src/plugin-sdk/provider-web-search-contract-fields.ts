// Provider web-search contract fields expose shared config keys for web-search-capable providers.
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

/** Credential storage mode advertised by a web-search-capable provider. */
export type WebSearchProviderContractCredential =
  | { type: "none" }
  | { type: "top-level" }
  | { type: "scoped"; scopeId: string };

/** Config location used when a provider also stores credentials in plugin config. */
export type WebSearchProviderConfiguredCredential = {
  /** Plugin id whose config entry owns the credential value. */
  pluginId: string;
  /** Field name under the plugin config entry. Defaults to `apiKey`. */
  field?: string;
};

/** Inputs for building the shared credential accessors on web-search providers. */
export type CreateWebSearchProviderContractFieldsOptions = {
  /** Legacy or inactive secret path that should be reported for migration/doctor flows. */
  credentialPath: string;
  /** Additional inactive secret paths when a provider retired more than one location. */
  inactiveSecretPaths?: string[];
  /** Search-config credential storage mode exposed through provider runtime hooks. */
  searchCredential: WebSearchProviderContractCredential;
  /** Optional plugin-config credential storage used by install/configuration flows. */
  configuredCredential?: WebSearchProviderConfiguredCredential;
};

/** Shared provider hooks produced by the web-search credential contract helper. */
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

/** Create the common credential hooks that web-search provider plugins spread into their entry. */
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
