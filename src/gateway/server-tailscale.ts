// Gateway Tailscale exposure helper.
// Applies Serve/Funnel routes and returns optional shutdown cleanup.
import { formatErrorMessage } from "../infra/errors.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import { prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  resetOnExit?: boolean;
  port: number;
  preserveFunnel?: boolean;
  serviceName?: string;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  const serviceName =
    params.tailscaleMode === "serve" ? params.serviceName?.trim() || undefined : undefined;
  let effectiveMode = params.tailscaleMode;
  let preservedFunnel = false;
  let clearPublishedOrigin: (() => void) | undefined;

  try {
    if (params.tailscaleMode === "serve") {
      if (params.preserveFunnel === true) {
        const funnelCovers = await hasTailscaleFunnelRouteForPort(params.port);
        if (funnelCovers) {
          effectiveMode = "funnel";
          preservedFunnel = true;
          const resetSuffix = params.resetOnExit
            ? "; resetOnExit is a no-op because no Serve route was applied this run"
            : "";
          params.logTailscale.info(
            `serve skipped: preserving externally configured Tailscale Funnel for port ${params.port}${resetSuffix}`,
          );
        }
      }
      if (!preservedFunnel) {
        if (serviceName) {
          await enableTailscaleServe(params.port, undefined, serviceName);
        } else {
          await enableTailscaleServe(params.port);
        }
      }
    } else {
      await enableTailscaleFunnel(params.port);
    }
    const host = await getTailnetHostname().catch(() => null);
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
        if (!preservedFunnel) {
          const serviceLabel = serviceName ? ` for ${serviceName}` : "";
          params.logTailscale.info(
            `${params.tailscaleMode} enabled${serviceLabel}: https://${publicHost}${uiPath} (WS via wss://${publicHost})`,
          );
        }
      } else if (!preservedFunnel) {
        params.logTailscale.info(`${params.tailscaleMode} enabled`);
      }
    } else if (!preservedFunnel) {
      params.logTailscale.info(`${params.tailscaleMode} enabled`);
    }
  } catch (err) {
    params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
  }

  if (!params.resetOnExit && !clearPublishedOrigin) {
    return null;
  }

  return async () => {
    clearPublishedOrigin?.();
    if (!params.resetOnExit || preservedFunnel) {
      return;
    }
    try {
      if (params.tailscaleMode === "serve") {
        if (serviceName) {
          await disableTailscaleServe(undefined, serviceName);
        } else {
          await disableTailscaleServe();
        }
      } else {
        await disableTailscaleFunnel();
      }
    } catch (err) {
      params.logTailscale.warn(
        `${params.tailscaleMode} cleanup failed: ${formatErrorMessage(err)}`,
      );
    }
  };
}
