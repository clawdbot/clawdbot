// Gateway Tailscale exposure helper.
// Applies Serve/Funnel routes and returns optional shutdown cleanup.
import { formatErrorMessage } from "../infra/errors.js";
import {
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import { prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  port: number;
  backend?: GatewayTailscaleIngressEndpoint;
  preserveFunnel?: boolean;
  serviceName?: string;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backend) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const backendTarget = params.backend.port;
  const serviceName =
    params.tailscaleMode === "serve" ? params.serviceName?.trim() || undefined : undefined;
  const effectiveMode = params.tailscaleMode;
  let clearPublishedOrigin: (() => void) | undefined;

  const applyRoute = async (target: number | string) => {
    if (params.tailscaleMode === "serve") {
      if (serviceName) {
        await enableTailscaleServe(target, undefined, serviceName);
      } else {
        await enableTailscaleServe(target);
      }
      return;
    }
    await enableTailscaleFunnel(target);
  };
  if (params.tailscaleMode === "serve" && params.preserveFunnel === true) {
    let preservedFunnel: boolean;
    try {
      preservedFunnel = await hasTailscaleFunnelRouteForPort(params.port);
    } catch (error) {
      params.logTailscale.warn(
        `serve not changed because external Funnel status could not be inspected: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    if (preservedFunnel) {
      params.logTailscale.warn(
        `external Tailscale Funnel for port ${params.port} remains active only for plugin-authenticated webhook routes; Gateway-authenticated routes reject its unattributable ingress. ` +
          "First configure a durable gateway password (gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD) and set gateway.auth.mode=password, " +
          "then run `openclaw config set gateway.tailscale.mode funnel` and `openclaw config unset gateway.tailscale.preserveFunnel`; " +
          "see https://docs.openclaw.ai/gateway/tailscale#public-internet-funnel--shared-password",
      );
      return null;
    }
  }

  try {
    await applyRoute(backendTarget);
    const host = await (
      params.tailscaleMode === "serve" ? getTailnetHostnameAfterServe() : getTailnetHostname()
    ).catch(() => null);
    if (host) {
      const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
      const publicHost = resolveTailscalePublishedHost({
        tailscaleMode: effectiveMode,
        tailnetHost: host,
        serviceName: effectiveMode === "serve" ? serviceName : undefined,
      });
      if (publicHost) {
        clearPublishedOrigin = prepareMcpAppChannelOrigin({
          origin: `https://${publicHost}`,
          reachability: effectiveMode === "funnel" ? "internet" : "tailnet",
        });
        const serviceLabel = serviceName ? ` for ${serviceName}` : "";
        params.logTailscale.info(
          `${params.tailscaleMode} enabled${serviceLabel}: https://${publicHost}${uiPath} (WS via wss://${publicHost})`,
        );
      } else {
        params.logTailscale.info(`${params.tailscaleMode} enabled`);
      }
    } else {
      params.logTailscale.info(`${params.tailscaleMode} enabled`);
    }
  } catch (err) {
    params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
    throw err;
  }

  return async () => {
    clearPublishedOrigin?.();
  };
}
