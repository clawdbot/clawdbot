import type { OpenClawConfig } from "../config/types.openclaw.js";

// Model pricing is enabled by default; config can explicitly disable it for
// deployments that do not want gateway cost lookups or display metadata.
/** Returns whether gateway model pricing/cost metadata should be shown. */
export function isGatewayModelPricingEnabled(config: OpenClawConfig): boolean {
  return config.models?.pricing?.enabled !== false;
}
