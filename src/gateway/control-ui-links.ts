// Control UI link builder for local, LAN, tailnet, and custom gateway binds.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAdvertisedLanHost } from "../infra/advertised-lan-host.js";
import {
  inspectBestEffortPrimaryTailnetIPv4,
  pickBestEffortPrimaryLanIPv4,
} from "../infra/network-discovery-display.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { isValidIPv4 } from "./net.js";

type ControlUiLinkParams = {
  port: number;
  bind?: "auto" | "lan" | "loopback" | "custom" | "tailnet";
  customBindHost?: string;
  basePath?: string;
  tlsEnabled?: boolean;
};

type ControlUiLinks = { httpUrl: string; wsUrl: string };

/** Resolve the advertised HTTP and websocket URLs for the Control UI. */
export function resolveControlUiLinks(
  params: ControlUiLinkParams & { advertisedLanHost?: string | null },
): ControlUiLinks {
  // Current BYOH truth: lan, tailnet, and custom bind resolve through IPv4-only helpers.
  // IPv6-only hosts need an IPv4 sidecar or proxy in front of the Gateway.
  const port = params.port;
  const bind = params.bind ?? "loopback";
  const customBindHost = params.customBindHost?.trim();
  const advertisedLanHost = normalizeOptionalString(params.advertisedLanHost);
  const { tailnetIPv4 } = inspectBestEffortPrimaryTailnetIPv4();
  const host = (() => {
    if (bind === "custom" && customBindHost && isValidIPv4(customBindHost)) {
      return customBindHost;
    }
    if (bind === "tailnet" && tailnetIPv4) {
      return tailnetIPv4 ?? "127.0.0.1";
    }
    if (bind === "lan") {
      return advertisedLanHost ?? pickBestEffortPrimaryLanIPv4() ?? "127.0.0.1";
    }
    return "127.0.0.1";
  })();
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const wsPath = basePath ? basePath : "";
  const httpScheme = params.tlsEnabled === true ? "https" : "http";
  const wsScheme = params.tlsEnabled === true ? "wss" : "ws";
  return {
    httpUrl: `${httpScheme}://${host}:${port}${uiPath}`,
    wsUrl: `${wsScheme}://${host}:${port}${wsPath}`,
  };
}

/** Resolve Control UI URLs meant for display to nearby devices. */
export async function resolveAdvertisedControlUiLinks(
  params: ControlUiLinkParams,
): Promise<ControlUiLinks> {
  const advertisedLanHost =
    params.bind === "lan" ? await resolveAdvertisedLanHost().catch(() => null) : null;
  return resolveControlUiLinks({
    ...params,
    advertisedLanHost,
  });
}

/** Resolve Control UI URLs for co-located readiness probes and health checks. */
export function resolveLocalControlUiProbeLinks(params: ControlUiLinkParams): ControlUiLinks {
  return resolveControlUiLinks({
    ...params,
    bind: params.bind === "lan" ? "loopback" : params.bind,
  });
}
