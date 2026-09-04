// Gateway Tailscale exposure helper.
// Claims Serve/Funnel routes, re-claims them when the foreground owner dies,
// and returns optional shutdown cleanup.
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { TailscaleRouteOwnershipConflictError } from "../infra/tailscale-route-ownership-error.js";
import {
  claimTailscaleRoute,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import { prepareMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";

// A restarted or upgraded Tailscale daemon drops every foreground claim at once.
// Retry quickly first, then settle to one attempt per minute while it stays down.
const RECLAIM_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000, factor: 2, jitter: 0.2 };

type ManagedTailscaleRoute = {
  claim: Awaited<ReturnType<typeof claimTailscaleRoute>>;
  releaseOrigin: () => void;
};

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  port: number;
  backend?: GatewayTailscaleIngressEndpoint;
  preserveFunnel?: boolean;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backend) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const mode = params.tailscaleMode;
  const backendTarget = params.backend.port;
  if (mode === "serve" && params.preserveFunnel === true) {
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

  const claimRoute = async (): Promise<ManagedTailscaleRoute> => {
    let claim: ManagedTailscaleRoute["claim"] | undefined;
    let releaseOrigin = () => {};
    try {
      claim = await claimTailscaleRoute(mode, backendTarget, params.port, params.logTailscale.info);
      const host = await (
        mode === "serve" ? getTailnetHostnameAfterServe() : getTailnetHostname()
      ).catch(() => null);
      if (!claim.isActive()) {
        throw new Error(`Managed Tailscale ${mode} claim exited during startup`);
      }
      const publicHost = resolveTailscalePublishedHost({ tailscaleMode: mode, tailnetHost: host });
      if (publicHost) {
        releaseOrigin = prepareMcpAppChannelOrigin({
          origin: `https://${publicHost}`,
          reachability: mode === "funnel" ? "internet" : "tailnet",
        });
        const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
        params.logTailscale.info(
          `${mode} enabled: https://${publicHost}${uiPath} (WS via wss://${publicHost})`,
        );
      } else {
        params.logTailscale.info(`${mode} enabled`);
      }
      return { claim, releaseOrigin };
    } catch (err) {
      releaseOrigin();
      await claim?.stop();
      params.logTailscale.warn(`${mode} failed: ${formatErrorMessage(err)}`);
      throw err;
    }
  };

  let stopping = false;
  let route = await claimRoute();
  let reclaiming: Promise<void> | undefined;
  const reclaimAbort = new AbortController();

  const reclaimRoute = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await sleepWithAbort(computeBackoff(RECLAIM_BACKOFF, attempt), reclaimAbort.signal, {
          ref: false,
        });
        // Cleanup awaits this promise, then releases whatever `route` holds.
        route = await claimRoute();
      } catch (err) {
        if (stopping) {
          return;
        }
        if (err instanceof TailscaleRouteOwnershipConflictError) {
          params.logTailscale.warn(
            `${mode} route is now owned elsewhere; managed Tailscale ingress stays down until the Gateway restarts`,
          );
          return;
        }
        continue;
      }
      watchRoute(route);
      return;
    }
  };

  const watchRoute = (watched: ManagedTailscaleRoute) => {
    void watched.claim.exited.then(() => {
      if (stopping) {
        return;
      }
      watched.releaseOrigin();
      params.logTailscale.warn(`${mode} route claim exited; reclaiming managed Tailscale ingress`);
      const pending: Promise<void> = reclaimRoute().finally(() => {
        if (reclaiming === pending) {
          reclaiming = undefined;
        }
      });
      reclaiming = pending;
    });
  };

  watchRoute(route);
  return async () => {
    stopping = true;
    reclaimAbort.abort();
    await reclaiming;
    route.releaseOrigin();
    await route.claim.stop();
  };
}
