/**
 * Plugin tool delivery-default hook.
 * Centralizes future delivery-context defaults before final effective tool
 * policy without changing plugin tool identity.
 */
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Applies delivery-context defaults to plugin tools before final tool policy. */
export function applyPluginToolDeliveryDefaults(params: {
  tools: AnyAgentTool[];
  deliveryContext?: DeliveryContext;
}): AnyAgentTool[] {
  void params.deliveryContext;
  return params.tools;
}
