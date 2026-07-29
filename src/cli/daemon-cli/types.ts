// Shared option types for Gateway service CLI commands.
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";

/** RPC probe options accepted by Gateway service status commands. */
export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

/** Full option bag for Gateway service status. */
export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  requireRpc: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

/** Options for installing or rewriting the Gateway service. */
export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  wrapper?: string;
  force?: boolean;
  json?: boolean;
};

/** Options shared by service start/stop/restart/uninstall commands. */
export type DaemonLifecycleOptions = {
  json?: boolean;
  force?: boolean;
  safe?: boolean;
  skipDeferral?: boolean;
  wait?: string;
  disable?: boolean;
};
