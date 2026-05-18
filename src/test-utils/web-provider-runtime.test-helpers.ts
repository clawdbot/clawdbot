import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";

type CommonWebProviderTestParams = {
  pluginId: string;
  id: string;
  credentialPath: string;
  autoDetectOrder?: number;
  requiresCredential?: boolean;
  getCredentialValue?: (config?: Record<string, unknown>) => unknown;
  getConfiguredCredentialValue?: (config?: OpenClawConfig) => unknown;
  getConfiguredCredentialFallback?:
    | PluginWebSearchProviderEntry["getConfiguredCredentialFallback"]
    | PluginWebFetchProviderEntry["getConfiguredCredentialFallback"];
};

export type WebSearchTestProviderParams = CommonWebProviderTestParams & {
  createTool?: PluginWebSearchProviderEntry["createTool"];
  getConfiguredCredentialFallback?: PluginWebSearchProviderEntry["getConfiguredCredentialFallback"];
};

export type WebFetchTestProviderParams = CommonWebProviderTestParams & {
  createTool?: PluginWebFetchProviderEntry["createTool"];
  getConfiguredCredentialFallback?: PluginWebFetchProviderEntry["getConfiguredCredentialFallback"];
};

function createCommonProviderFields(params: CommonWebProviderTestParams) {
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} runtime provider`,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    placeholder: `${params.id}-...`,
    signupUrl: `https://example.com/${params.id}`,
    credentialPath: params.credentialPath,
    autoDetectOrder: params.autoDetectOrder,
    requiresCredential: params.requiresCredential,
    getCredentialValue: params.getCredentialValue ?? (() => undefined),
    setCredentialValue: () => {},
    getConfiguredCredentialValue: params.getConfiguredCredentialValue,
    getConfiguredCredentialFallback: params.getConfiguredCredentialFallback,
  };
}

function createDefaultProviderTool(providerId: string) {
  return {
    description: providerId,
    parameters: {},
    execute: async (args: Record<string, unknown>) => ({ ...args, provider: providerId }),
  };
}

export function createWebSearchTestProvider(
  params: WebSearchTestProviderParams,
): PluginWebSearchProviderEntry {
  return {
    ...createCommonProviderFields(params),
    createTool: params.createTool ?? (() => createDefaultProviderTool(params.id)),
  };
}

export function createWebFetchTestProvider(
  params: WebFetchTestProviderParams,
): PluginWebFetchProviderEntry {
  return {
    ...createCommonProviderFields(params),
    createTool: params.createTool ?? (() => createDefaultProviderTool(params.id)),
  };
}
