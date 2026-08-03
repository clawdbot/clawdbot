// Normalized status overview surface shared by text and JSON status outputs.
// It collects gateway/update/service fields into one shape before row or payload builders run.

import {
  buildGatewayStatusJsonPayload,
  buildStatusOverviewSurfaceRows,
} from "./status-all/format.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

type StatusOverviewRowInput = Parameters<typeof buildStatusOverviewSurfaceRows>[0];
type StatusOverviewFormatOptions = Pick<
  StatusOverviewRowInput,
  | "tailscaleBackendState"
  | "includeBackendStateWhenOff"
  | "includeBackendStateWhenOn"
  | "includeDnsNameWhenOff"
  | "decorateTailscaleOff"
  | "decorateTailscaleWarn"
  | "decorateOk"
  | "decorateWarn"
  | "prefixRows"
  | "middleRows"
  | "suffixRows"
  | "agentsValue"
  | "updateValue"
  | "gatewayAuthWarningValue"
  | "gatewaySelfFallbackValue"
>;

export type StatusOverviewSurface = Omit<
  StatusOverviewRowInput,
  keyof StatusOverviewFormatOptions | "nodeOnlyGateway"
> & {
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
};

type StatusOverviewServices = Pick<
  StatusOverviewSurface,
  "gatewayService" | "nodeService" | "nodeOnlyGateway"
>;
type StatusOverviewSourceKeys = Exclude<keyof StatusOverviewSurface, keyof StatusOverviewServices>;
type StatusSource<T> = Pick<T, Extract<keyof T, StatusOverviewSourceKeys>>;
type StatusScanInput = StatusSource<StatusScanResult>;
type StatusOverviewInput = StatusSource<StatusScanOverviewResult> &
  Pick<StatusScanOverviewResult, "gatewaySnapshot">;

/** Converts the full status scan result into the shared overview surface. */
export function buildStatusOverviewSurfaceFromScan(
  params: { scan: StatusScanInput } & StatusOverviewServices,
): StatusOverviewSurface {
  return {
    cfg: params.scan.cfg,
    update: params.scan.update,
    tailscaleMode: params.scan.tailscaleMode,
    tailscaleDns: params.scan.tailscaleDns,
    tailscaleHttpsUrl: params.scan.tailscaleHttpsUrl,
    ...(params.scan.advertisedControlUiLinks
      ? { advertisedControlUiLinks: params.scan.advertisedControlUiLinks }
      : {}),
    gatewayMode: params.scan.gatewayMode,
    remoteUrlMissing: params.scan.remoteUrlMissing,
    gatewayConnection: params.scan.gatewayConnection,
    gatewayReachable: params.scan.gatewayReachable,
    gatewayProbe: params.scan.gatewayProbe,
    gatewayProbeAuth: params.scan.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.scan.gatewayProbeAuthWarning,
    gatewaySelf: params.scan.gatewaySelf,
    gatewayService: params.gatewayService,
    nodeService: params.nodeService,
    nodeOnlyGateway: params.nodeOnlyGateway,
  };
}

/** Converts the lighter status-all overview scan into the shared overview surface. */
export function buildStatusOverviewSurfaceFromOverview(
  params: { overview: StatusOverviewInput } & StatusOverviewServices,
): StatusOverviewSurface {
  return {
    cfg: params.overview.cfg,
    update: params.overview.update,
    tailscaleMode: params.overview.tailscaleMode,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    ...(params.overview.advertisedControlUiLinks
      ? { advertisedControlUiLinks: params.overview.advertisedControlUiLinks }
      : {}),
    gatewayMode: params.overview.gatewaySnapshot.gatewayMode,
    remoteUrlMissing: params.overview.gatewaySnapshot.remoteUrlMissing,
    gatewayConnection: params.overview.gatewaySnapshot.gatewayConnection,
    gatewayReachable: params.overview.gatewaySnapshot.gatewayReachable,
    gatewayProbe: params.overview.gatewaySnapshot.gatewayProbe,
    gatewayProbeAuth: params.overview.gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.overview.gatewaySnapshot.gatewayProbeAuthWarning,
    gatewaySelf: params.overview.gatewaySnapshot.gatewaySelf,
    gatewayService: params.gatewayService,
    nodeService: params.nodeService,
    nodeOnlyGateway: params.nodeOnlyGateway,
  };
}

/** Builds overview rows from an already-normalized surface. */
export function buildStatusOverviewRowsFromSurface(
  params: { surface: StatusOverviewSurface } & StatusOverviewFormatOptions,
) {
  const { surface, ...options } = params;
  return buildStatusOverviewSurfaceRows({ ...surface, ...options });
}

/** Builds the gateway JSON payload from the gateway portion of an overview surface. */
export function buildStatusGatewayJsonPayloadFromSurface(params: {
  surface: Pick<StatusOverviewSurface, keyof Parameters<typeof buildGatewayStatusJsonPayload>[0]>;
}) {
  return buildGatewayStatusJsonPayload(params.surface);
}
