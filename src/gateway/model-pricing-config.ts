import type { OpenClawConfig } from "../config/types.openclaw.js";

export function isGatewayModelPricingEnabled(config: OpenClawConfig): boolean {
  return config.models?.pricing?.enabled !== false;
}
