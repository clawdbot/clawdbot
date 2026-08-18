// Explicit connection policy decides when CLI gateway calls can avoid reading
// config because URL and auth were fully supplied by flags.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";

// Explicit connection policy lets CLI paths skip config IO only when the caller
// provided both a URL and concrete auth. Cron stays a bypass path because it
// owns gateway startup/config loading separately.
function hasExplicitGatewayConnectionAuth(auth?: ExplicitGatewayAuth): boolean {
  return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}

// gateway.remote.edgeAuth lives in config and only ever applies to secure remote
// targets. Skipping the config load for one would silently drop the edge
// credential and surface as an identity-proxy rejection the flags cannot explain.
function targetMayRequireConfiguredEdgeAuth(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "wss:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Returns true when url/auth flags are sufficient and loading OpenClaw config is unnecessary. */
export function canSkipGatewayConfigLoad(params: {
  config?: OpenClawConfig;
  urlOverride?: string;
  explicitAuth?: ExplicitGatewayAuth;
}): boolean {
  const urlOverride = trimToUndefined(params.urlOverride);
  if (!urlOverride || params.config || !hasExplicitGatewayConnectionAuth(params.explicitAuth)) {
    return false;
  }
  return !targetMayRequireConfiguredEdgeAuth(urlOverride);
}
