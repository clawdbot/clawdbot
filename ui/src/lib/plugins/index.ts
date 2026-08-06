// Shared Control UI plugin catalog Gateway contracts.
import {
  ClawHubTrustErrorCodes,
  readClawHubTrustErrorDetails,
  type ClawHubTrustErrorDetails,
} from "../../../../packages/gateway-protocol/src/clawhub-trust-error-details.js";
import type {
  PluginCatalogEntry,
  PluginsInstallParams,
  PluginsInstallResult,
  PluginsListResult as ProtocolPluginsListResult,
  PluginsSearchResult as ProtocolPluginsSearchResult,
  PluginsSetEnabledResult,
  PluginsUninstallResult,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../config/index.ts";

export type PluginCatalogItem = PluginCatalogEntry;
export type PluginListResult = ProtocolPluginsListResult;
export type PluginSearchResult = ProtocolPluginsSearchResult["results"][number];
export type PluginInstallRequest = PluginsInstallParams;
export type PluginMutationResult = PluginsInstallResult | PluginsSetEnabledResult;
type PluginUninstallResult = PluginsUninstallResult;

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
): Promise<PluginMutationResult> {
  return client.request<PluginMutationResult>("plugins.setEnabled", { pluginId, enabled });
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
      // ClawHub risk acknowledgment requires the original structured Gateway error.
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

export function readPluginInstallTrustError(error: unknown): ClawHubTrustErrorDetails | undefined {
  if (!(error instanceof GatewayRequestError)) {
    return undefined;
  }
  return readClawHubTrustErrorDetails(error.details);
}

export function pluginInstallNeedsRiskAcknowledgement(error: unknown): boolean {
  return (
    readPluginInstallTrustError(error)?.clawhubTrustCode ===
    ClawHubTrustErrorCodes.RISK_ACKNOWLEDGEMENT_REQUIRED
  );
}
