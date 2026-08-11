// Gateway Tailscale exposure helper.
// Applies Serve/Funnel routes and returns optional shutdown cleanup.
import { formatErrorMessage } from "../infra/errors.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import { prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  resetOnExit?: boolean;
  port: number;
  backendPort?: number;
  preserveFunnel?: boolean;
  serviceName?: string;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backendPort) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const serviceName =
    params.tailscaleMode === "serve" ? params.serviceName?.trim() || undefined : undefined;
  const effectiveMode = params.tailscaleMode;
  let clearPublishedOrigin: (() => void) | undefined;

  const applyRoute = async (port: number) => {
    if (params.tailscaleMode === "serve") {
      if (serviceName) {
        await enableTailscaleServe(port, undefined, serviceName);
      } else {
        await enableTailscaleServe(port);
      }
      return;
    }
    await enableTailscaleFunnel(port);
  };
  const clearRoute = async () => {
    if (params.tailscaleMode === "serve") {
      if (serviceName) {
        await disableTailscaleServe(undefined, serviceName);
      } else {
        await disableTailscaleServe();
      }
      return;
    }
    await disableTailscaleFunnel();
  };

  if (params.tailscaleMode === "serve" && params.preserveFunnel === true) {
    let preservedFunnel: boolean;
    try {
      preservedFunnel = await hasTailscaleFunnelRouteForPort(params.port);
    } catch (error) {
      params.logTailscale.warn(
        `serve not changed because external Funnel status could not be inspected: ${formatErrorMessage(error)}`,
      );
      return null;
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

  let routeEnabled = false;
  try {
    await applyRoute(params.backendPort);
    routeEnabled = true;
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
  }

  if (!routeEnabled) {
    return null;
  }

  return async () => {
    clearPublishedOrigin?.();
    try {
      if (params.resetOnExit) {
        await clearRoute();
      } else {
        // Background routes persist by product contract. Before the private ephemeral
        // listener closes, restore the route to the stable configured Gateway port.
        await applyRoute(params.port);
      }
    } catch (err) {
      params.logTailscale.warn(
        `${params.tailscaleMode} cleanup failed: ${formatErrorMessage(err)}`,
      );
      // A reset clears the node-wide Serve/Funnel configuration. Never use it as
      // fallback for a failed persistent-route restore: a concurrent operator
      // update or an unrelated handler must survive this Gateway's shutdown.
    }
  };
}
