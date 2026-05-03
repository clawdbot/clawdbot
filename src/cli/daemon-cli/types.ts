import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  requireRpc: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  wrapper?: string;
  force?: boolean;
  json?: boolean;
};

export type DaemonLifecycleOptions = {
  json?: boolean;
  force?: boolean;
  wait?: string;
};
