import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  buildGatewayStatusJsonPayload,
  buildStatusOverviewSurfaceRows,
  type StatusOverviewRow,
} from "./status-all/format.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

type StatusGatewayConnection = {
  url: string;
  urlSource?: string;
};

type StatusGatewayProbe = {
  connectLatencyMs?: number | null;
  error?: string | null;
  health?: unknown;
} | null;

type StatusGatewayAuth = {
  token?: string;
  password?: string;
} | null;

type StatusGatewaySelf =
  | {
      host?: string | null;
      ip?: string | null;
      version?: string | null;
      platform?: string | null;
    }
  | null
  | undefined;

type StatusServiceSummary = {
  label: string;
  installed: boolean | null;
  managedByOpenClaw?: boolean;
  loadedText: string;
  runtimeShort?: string | null;
  runtime?: {
    status?: string | null;
    pid?: number | null;
  } | null;
};

export type StatusOverviewSurface = {
  cfg: Pick<OpenClawConfig, "update" | "gateway">;
  update: UpdateCheckResult;
  tailscaleMode: string;
  tailscaleDns?: string | null;
  tailscaleHttpsUrl?: string | null;
  gatewayMode: "local" | "remote";
  remoteUrlMissing: boolean;
  gatewayConnection: StatusGatewayConnection;
  gatewayReachable: boolean;
  gatewayProbe: StatusGatewayProbe;
  gatewayProbeAuth: StatusGatewayAuth;
  gatewayProbeAuthWarning?: string | null;
  gatewaySelf: StatusGatewaySelf;
  gatewayService: StatusServiceSummary;
  nodeService: StatusServiceSummary;
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
};

export function buildStatusOverviewSurfaceFromScan(params: {
  scan: Pick<
    StatusScanResult,
    | "cfg"
    | "update"
    | "tailscaleMode"
    | "tailscaleDns"
    | "tailscaleHttpsUrl"
    | "gatewayMode"
    | "remoteUrlMissing"
    | "gatewayConnection"
    | "gatewayReachable"
    | "gatewayProbe"
    | "gatewayProbeAuth"
    | "gatewayProbeAuthWarning"
    | "gatewaySelf"
  >;
  gatewayService: StatusServiceSummary;
  nodeService: StatusServiceSummary;
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}): StatusOverviewSurface {
  return {
    cfg: params.scan.cfg,
    update: params.scan.update,
    tailscaleMode: params.scan.tailscaleMode,
    tailscaleDns: params.scan.tailscaleDns,
    tailscaleHttpsUrl: params.scan.tailscaleHttpsUrl,
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

export function buildStatusOverviewSurfaceFromOverview(params: {
  overview: Pick<
    StatusScanOverviewResult,
    "cfg" | "update" | "tailscaleMode" | "tailscaleDns" | "tailscaleHttpsUrl" | "gatewaySnapshot"
  >;
  gatewayService: StatusServiceSummary;
  nodeService: StatusServiceSummary;
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}): StatusOverviewSurface {
  return {
    cfg: params.overview.cfg,
    update: params.overview.update,
    tailscaleMode: params.overview.tailscaleMode,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
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

export function buildStatusOverviewRowsFromSurface(params: {
  surface: StatusOverviewSurface;
  prefixRows?: StatusOverviewRow[];
  middleRows?: StatusOverviewRow[];
  suffixRows?: StatusOverviewRow[];
  agentsValue: string;
  updateValue?: string;
  gatewayAuthWarningValue?: string | null;
  gatewaySelfFallbackValue?: string | null;
  tailscaleBackendState?: string | null;
  includeBackendStateWhenOff?: boolean;
  includeBackendStateWhenOn?: boolean;
  includeDnsNameWhenOff?: boolean;
  decorateOk?: (value: string) => string;
  decorateWarn?: (value: string) => string;
  decorateTailscaleOff?: (value: string) => string;
  decorateTailscaleWarn?: (value: string) => string;
}) {
  return buildStatusOverviewSurfaceRows({
    cfg: params.surface.cfg,
    update: params.surface.update,
    tailscaleMode: params.surface.tailscaleMode,
    tailscaleDns: params.surface.tailscaleDns,
    tailscaleHttpsUrl: params.surface.tailscaleHttpsUrl,
    tailscaleBackendState: params.tailscaleBackendState,
    includeBackendStateWhenOff: params.includeBackendStateWhenOff,
    includeBackendStateWhenOn: params.includeBackendStateWhenOn,
    includeDnsNameWhenOff: params.includeDnsNameWhenOff,
    decorateTailscaleOff: params.decorateTailscaleOff,
    decorateTailscaleWarn: params.decorateTailscaleWarn,
    gatewayMode: params.surface.gatewayMode,
    remoteUrlMissing: params.surface.remoteUrlMissing,
    gatewayConnection: params.surface.gatewayConnection,
    gatewayReachable: params.surface.gatewayReachable,
    gatewayProbe: params.surface.gatewayProbe,
    gatewayProbeAuth: params.surface.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
    gatewaySelf: params.surface.gatewaySelf,
    gatewayService: params.surface.gatewayService,
    nodeService: params.surface.nodeService,
    nodeOnlyGateway: params.surface.nodeOnlyGateway,
    decorateOk: params.decorateOk,
    decorateWarn: params.decorateWarn,
    prefixRows: params.prefixRows,
    middleRows: params.middleRows,
    suffixRows: params.suffixRows,
    agentsValue: params.agentsValue,
    updateValue: params.updateValue,
    gatewayAuthWarningValue: params.gatewayAuthWarningValue,
    gatewaySelfFallbackValue: params.gatewaySelfFallbackValue,
  });
}

export function buildStatusGatewayJsonPayloadFromSurface(params: {
  surface: Pick<
    StatusOverviewSurface,
    | "gatewayMode"
    | "gatewayConnection"
    | "remoteUrlMissing"
    | "gatewayReachable"
    | "gatewayProbe"
    | "gatewaySelf"
    | "gatewayProbeAuthWarning"
  >;
}) {
  return buildGatewayStatusJsonPayload({
    gatewayMode: params.surface.gatewayMode,
    gatewayConnection: params.surface.gatewayConnection,
    remoteUrlMissing: params.surface.remoteUrlMissing,
    gatewayReachable: params.surface.gatewayReachable,
    gatewayProbe: params.surface.gatewayProbe,
    gatewaySelf: params.surface.gatewaySelf,
    gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
  });
}
