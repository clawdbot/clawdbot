// Gateway model-pricing config helper.
// Resolves whether cost/pricing metadata should be available to Gateway surfaces.
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Returns whether gateway model pricing/cost metadata should be shown. */
export function isGatewayModelPricingEnabled(config: OpenClawConfig): boolean {
  return config.models?.pricing?.enabled !== false;
}
