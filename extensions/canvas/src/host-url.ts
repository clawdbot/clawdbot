/**
 * Canvas hosted-surface URL resolver.
 */
import {
  resolveHostedPluginSurfaceUrl,
  type HostedPluginSurfaceUrlParams,
} from "openclaw/plugin-sdk/gateway-runtime";

type CanvasHostUrlParams = Omit<HostedPluginSurfaceUrlParams, "port"> & {
  canvasPort?: number;
};

/** Resolves the externally visible Canvas host URL for a gateway/plugin surface. */
export function resolveCanvasHostUrl(params: CanvasHostUrlParams) {
  return resolveHostedPluginSurfaceUrl({
    ...params,
    port: params.canvasPort,
  });
}
