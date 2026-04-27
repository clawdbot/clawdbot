import type { PluginServicesHandle } from "../plugins/services.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  createGatewayServerMutableState,
  type GatewayServerMutableState,
} from "./server-runtime-handles.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";

export type GatewayServerLiveState = GatewayServerMutableState & {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  pluginServices: PluginServicesHandle | null;
  gatewayMethods: string[];
};

export function createGatewayServerLiveState(params: {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  gatewayMethods: string[];
}): GatewayServerLiveState {
  return {
    ...createGatewayServerMutableState(),
    hooksConfig: params.hooksConfig,
    hookClientIpConfig: params.hookClientIpConfig,
    cronState: params.cronState,
    pluginServices: null,
    gatewayMethods: params.gatewayMethods,
  };
}
