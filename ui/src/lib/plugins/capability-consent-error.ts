// Kept out of the boot-path plugin barrel: only the lazily loaded plugins page
// and consent controller need these, so startup never pays for them.
import {
  readCapabilityConsentErrorDetails,
  type CapabilityConsentErrorDetails,
} from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { PluginsInspectResult } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";

export function inspectPlugin(
  client: GatewayBrowserClient,
  pluginId: string,
): Promise<PluginsInspectResult> {
  return client.request<PluginsInspectResult>("plugins.inspect", { pluginId });
}

export function readPluginCapabilityConsentError(
  error: unknown,
): CapabilityConsentErrorDetails | undefined {
  if (!(error instanceof GatewayRequestError)) {
    return undefined;
  }
  return readCapabilityConsentErrorDetails(error.details);
}
