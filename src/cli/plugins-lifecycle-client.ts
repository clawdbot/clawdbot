import { readCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { PluginsInspectResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { getRuntimeConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";

export type PluginLifecycleGateway = <T>(
  method: string,
  params: Record<string, unknown>,
  onCapabilityConsent?: PluginCapabilityConsentHandler,
) => Promise<T>;

/** Select the local runtime owner before acquiring a lease the Gateway also needs. */
export async function resolvePluginLifecycleGateway(): Promise<PluginLifecycleGateway | null> {
  const owner = await readActiveGatewayLockIdentity();
  if (!owner) {
    return null;
  }
  const config = getRuntimeConfig();
  const request = <T>(method: string, params: Record<string, unknown>) =>
    callGateway<T>({
      config,
      method,
      params,
      localPortOverride: owner.port,
      ignoreEnvUrlOverride: true,
      requiredMethods: [...new Set([method, "plugins.reload"])],
      timeoutMs: 600_000,
      scopes: ["operator.admin"],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  return async <T>(
    method: string,
    params: Record<string, unknown>,
    onCapabilityConsent?: PluginCapabilityConsentHandler,
  ) => {
    try {
      return await request<T>(method, params);
    } catch (error) {
      const consent = readCapabilityConsentErrorDetails(
        error instanceof Error && "details" in error ? error.details : undefined,
      );
      if (!consent || !onCapabilityConsent) {
        throw error;
      }
      const { plugin, ...inspection } = await request<PluginsInspectResult>("plugins.inspect", {
        pluginId: consent.pluginId,
      });
      const acknowledgeCapabilities = await onCapabilityConsent({
        ...inspection,
        pluginId: plugin.id,
        name: plugin.name,
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(consent.widened ? { widened: consent.widened } : {}),
        ...(consent.acceptedAt ? { acceptedAt: consent.acceptedAt } : {}),
      });
      if (!acknowledgeCapabilities) {
        throw error;
      }
      // Only consent rejection is retryable. Connection failure is never proof of offline state.
      return await request<T>(method, { ...params, acknowledgeCapabilities });
    }
  };
}
