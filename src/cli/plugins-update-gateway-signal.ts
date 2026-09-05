import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, type CallGatewayOptions } from "../gateway/call.js";

type PluginMetadataGatewayCall = (opts: CallGatewayOptions) => Promise<unknown>;

/** Notifies the local Gateway that persisted plugin metadata changed without config writes. */
export async function notifyGatewayPluginMetadataChanged(
  config: OpenClawConfig,
  deps: { callGateway?: PluginMetadataGatewayCall } = {},
): Promise<boolean> {
  try {
    await (deps.callGateway ?? callGateway)({
      config,
      method: "plugins.refresh",
      params: {},
      timeoutMs: 1_000,
      localPortOverride: resolveGatewayPort(config),
      ignoreEnvUrlOverride: true,
      requiredMethods: ["plugins.refresh"],
      scopes: ["operator.admin"],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
    return true;
  } catch {
    // An offline or older Gateway is expected; the command still prints the restart instruction.
    return false;
  }
}
