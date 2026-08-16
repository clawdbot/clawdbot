import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import { GatewayScopeUpgrade } from "@openclaw/gateway-client/scope-upgrade";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../lib/nodes/index.ts";

export function createGatewayScopeUpgradeRuntime(params: {
  gatewayUrl: string;
  request: (
    method: string,
    requestParams?: unknown,
    options?: GatewayProtocolRequestOptions,
  ) => Promise<unknown>;
  reconnect: () => void;
}) {
  return new GatewayScopeUpgrade({
    request: params.request,
    tokenStore: {
      load: ({ deviceId, role }) =>
        loadDeviceAuthToken({ deviceId, gatewayUrl: params.gatewayUrl, role }),
      store: ({ deviceId, role, token, scopes }) => {
        storeDeviceAuthToken({
          deviceId,
          gatewayUrl: params.gatewayUrl,
          role,
          token,
          scopes,
        });
      },
      clear: ({ deviceId, role }) =>
        clearDeviceAuthToken({ deviceId, gatewayUrl: params.gatewayUrl, role }),
    },
    reconnect: params.reconnect,
  });
}
