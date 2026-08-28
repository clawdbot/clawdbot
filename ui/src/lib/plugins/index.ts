// Shared Control UI plugin catalog Gateway contracts.
import type {
  PluginCatalogEntry,
  PluginDeclaredSurface as ProtocolPluginDeclaredSurface,
  PluginHookGrant as ProtocolPluginHookGrant,
  PluginInspectSource as ProtocolPluginInspectSource,
  PluginOperatorGrants as ProtocolPluginOperatorGrants,
  PluginsInspectResult as ProtocolPluginsInspectResult,
  PluginsInstallParams,
  PluginsInstallResult,
  PluginsListResult as ProtocolPluginsListResult,
  PluginsSearchResult as ProtocolPluginsSearchResult,
  PluginsSetEnabledParams,
  PluginsSetEnabledResult,
  PluginsUninstallResult,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../config/runtime-config-capability.ts";

export type PluginCatalogItem = PluginCatalogEntry;
export type PluginDeclaredSurface = ProtocolPluginDeclaredSurface;
export type PluginHookGrant = ProtocolPluginHookGrant;
export type PluginInspectSource = ProtocolPluginInspectSource;
export type PluginOperatorGrants = ProtocolPluginOperatorGrants;
export type PluginsInspectResult = ProtocolPluginsInspectResult;
export type PluginListResult = ProtocolPluginsListResult;
export type PluginSearchResult = ProtocolPluginsSearchResult["results"][number];
export type PluginInstallRequest = PluginsInstallParams;
export type PluginMutationResult = PluginsInstallResult | PluginsSetEnabledResult;
type PluginUninstallResult = PluginsUninstallResult;

export function resolvePluginInstallIdentity(
  request: PluginInstallRequest,
  plugins: readonly PluginCatalogItem[],
  runtimeId?: string,
): string {
  if (request.source === "official") {
    return `plugin:${request.pluginId}`;
  }
  const catalogEntry =
    plugins.find(
      (plugin) =>
        plugin.packageName === request.packageName ||
        (plugin.install?.source === "clawhub" &&
          plugin.install.packageName === request.packageName),
    ) ?? (runtimeId ? plugins.find((plugin) => plugin.id === runtimeId) : undefined);
  return catalogEntry || runtimeId
    ? `plugin:${catalogEntry?.id ?? runtimeId}`
    : `clawhub:${request.packageName}`;
}

export const CLAWHUB_BROWSE_URL = "https://clawhub.ai/plugins";

export function loadPluginCatalog(client: GatewayBrowserClient): Promise<PluginListResult> {
  return client.request<PluginListResult>("plugins.list", {});
}

export function installPlugin(
  client: GatewayBrowserClient,
  request: PluginInstallRequest,
): Promise<PluginMutationResult> {
  return client.request<PluginMutationResult>("plugins.install", request);
}

export function uninstallPlugin(
  client: GatewayBrowserClient,
  pluginId: string,
): Promise<PluginUninstallResult> {
  return client.request<PluginUninstallResult>("plugins.uninstall", { pluginId });
}

export function setPluginEnabled(
  client: GatewayBrowserClient,
  pluginId: string,
  enabled: boolean,
  options?: Pick<PluginsSetEnabledParams, "acknowledgeCapabilities">,
): Promise<PluginMutationResult> {
  return client.request<PluginMutationResult>("plugins.setEnabled", {
    pluginId,
    enabled,
    ...options,
  });
}

/** Serialize every plugin config write without discarding structured Gateway failures. */
export async function runPluginConfigMutation<T>(
  runtimeConfig: Pick<RuntimeConfigCapability, "runExternalMutation">,
  expectedClient: GatewayBrowserClient,
  task: (client: GatewayBrowserClient) => Promise<T>,
): Promise<{ value: T; refreshError: string | null }> {
  let taskError: Error | undefined;
  const mutation = await runtimeConfig.runExternalMutation(async (client) => {
    if (client !== expectedClient) {
      throw new Error("Connection changed before the plugin update started.");
    }
    try {
      return await task(client);
    } catch (error) {
      // Preserve structured Gateway failures for the caller.
      taskError = error instanceof Error ? error : new Error(String(error));
      throw taskError;
    }
  });
  if (!mutation.ok) {
    throw taskError ?? new Error(mutation.error);
  }
  return {
    value: mutation.value,
    refreshError: mutation.refresh.ok ? null : mutation.refresh.error,
  };
}
