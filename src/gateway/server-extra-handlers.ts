import type { GatewayRequestHandlers } from "./server-methods/types.js";
import type { GatewayServerOptions } from "./server-public.js";

const attachedGatewayExtraHandlers = Symbol("openclaw.gateway.attached-extra-handlers");

type GatewayServerOptionsWithExtraHandlers = GatewayServerOptions & {
  [attachedGatewayExtraHandlers]?: GatewayRequestHandlers;
};

/** Attach process-local methods without adding them to the public Gateway options contract. */
export function withGatewayServerExtraHandlers(
  options: GatewayServerOptions,
  handlers: GatewayRequestHandlers,
): GatewayServerOptions {
  Object.defineProperty(options, attachedGatewayExtraHandlers, {
    configurable: false,
    enumerable: false,
    value: handlers,
    writable: false,
  });
  return options;
}

export function readGatewayServerExtraHandlers(
  options: GatewayServerOptions,
): GatewayRequestHandlers {
  return (options as GatewayServerOptionsWithExtraHandlers)[attachedGatewayExtraHandlers] ?? {};
}
