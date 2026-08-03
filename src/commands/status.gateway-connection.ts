// Gateway connection detail formatting for status reports.
// Keeps verbose human text and status-all connection sections consistent.

import type { RuntimeEnv } from "../runtime.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";

/** Logs multi-line gateway connection details with the standard heading. */
export function logGatewayConnectionDetails(params: {
  runtime: Pick<RuntimeEnv, "log">;
  info: (value: string) => string;
  message: string;
  trailingBlankLine?: boolean;
}) {
  params.runtime.log(params.info("Gateway connection:"));
  for (const line of params.message.split("\n")) {
    params.runtime.log(`  ${line}`);
  }
  if (params.trailingBlankLine) {
    params.runtime.log("");
  }
}

/** Builds status-all gateway connection details, including remote-url fallback diagnostics. */
export function resolveStatusAllConnectionDetails(params: {
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  remoteUrlMissing: boolean;
  gatewayConnection: StatusScanOverviewResult["gatewaySnapshot"]["gatewayConnection"];
  bindMode?: string | null;
  configPath: string;
}): string {
  if (params.nodeOnlyGateway) {
    return params.nodeOnlyGateway.connectionDetails;
  }
  if (!params.remoteUrlMissing) {
    return params.gatewayConnection.message;
  }
  // Remote mode without a URL probes local fallback only so the report can still diagnose config.
  return [
    "Gateway mode: remote",
    "Gateway target: (missing gateway.remote.url)",
    `Config: ${params.configPath}`,
    `Bind: ${params.bindMode ?? "loopback"}`,
    `Local fallback (used for probes): ${params.gatewayConnection.url}`,
    "Fix: set gateway.remote.url, or set gateway.mode=local.",
  ].join("\n");
}
