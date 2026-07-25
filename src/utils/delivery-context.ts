// Delivery context helpers normalize target and route metadata for delivery.
export {
  deliveryContextFromSession,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  sessionDeliveryChannel,
} from "./delivery-context.shared.js";
export type { DeliveryContext } from "./delivery-context.types.js";
