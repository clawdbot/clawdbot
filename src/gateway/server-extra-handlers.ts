import type { GatewayRequestHandlers } from "./server-methods/types.js";
import type { GatewayServerOptions } from "./server-public.js";

const attachedGatewayExtraHandlers = new WeakMap<GatewayServerOptions, GatewayRequestHandlers>();

/** Attach process-local methods without adding them to the public Gateway options contract. */
export function withGatewayServerExtraHandlers(
  options: GatewayServerOptions,
  handlers: GatewayRequestHandlers,
): GatewayServerOptions {
  attachedGatewayExtraHandlers.set(options, handlers);
  return options;
}

export function readGatewayServerExtraHandlers(
  options: GatewayServerOptions,
): GatewayRequestHandlers {
  return attachedGatewayExtraHandlers.get(options) ?? {};
}
