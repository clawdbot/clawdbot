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

export type PluginCatalogItem = PluginCatalogEntry;
export type PluginListResult = ProtocolPluginsListResult;
export type PluginSearchResult = ProtocolPluginsSearchResult["results"][number];
type PluginSearchResponse = ProtocolPluginsSearchResult;
export type PluginInstallRequest = PluginsInstallParams;
export type PluginMutationResult = PluginsInstallResult | PluginsSetEnabledResult;
type PluginUninstallResult = PluginsUninstallResult;

export const CLAWHUB_BROWSE_URL = "https://clawhub.ai/plugins";

export function loadPluginCatalog(client: GatewayBrowserClient): Promise<PluginListResult> {
  return client.request<PluginListResult>("plugins.list", {});
}

export function searchPluginCatalog(
  client: GatewayBrowserClient,
  query: string,
): Promise<PluginSearchResponse> {
  return client.request<PluginSearchResponse>("plugins.search", { query, limit: 20 });
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
