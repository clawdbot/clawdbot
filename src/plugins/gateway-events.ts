import type { PluginJsonValue } from "./host-hook-json.js";

export type OpenClawPluginGatewayEventScope = "operator.read" | "operator.write" | "operator.admin";

export type OpenClawPluginGatewayEvents = {
  emit: (
    event: string,
    payload: PluginJsonValue,
    opts: { scope: OpenClawPluginGatewayEventScope },
  ) => void;
};
