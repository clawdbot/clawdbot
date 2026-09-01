import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import type { GatewayServerOptions } from "./server-public.js";

export type GatewayServerExtraHttpRoute = {
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
};

type GatewayServerExtras = {
  handlers: GatewayRequestHandlers;
  httpRoutes: readonly GatewayServerExtraHttpRoute[];
};

const attachedGatewayExtras = new WeakMap<GatewayServerOptions, GatewayServerExtras>();

/** Attach process-local surfaces without adding them to the public Gateway options contract. */
export function withGatewayServerExtraHandlers(
  options: GatewayServerOptions,
  handlers: GatewayRequestHandlers,
  httpRoutes: readonly GatewayServerExtraHttpRoute[] = [],
): GatewayServerOptions {
  attachedGatewayExtras.set(options, { handlers, httpRoutes });
  return options;
}

export function readGatewayServerExtraHandlers(
  options: GatewayServerOptions,
): GatewayRequestHandlers {
  return attachedGatewayExtras.get(options)?.handlers ?? {};
}

export function readGatewayServerExtraHttpRoutes(
  options: GatewayServerOptions,
): readonly GatewayServerExtraHttpRoute[] {
  return attachedGatewayExtras.get(options)?.httpRoutes ?? [];
}

export function copyGatewayServerExtras(
  source: GatewayServerOptions,
  target: GatewayServerOptions,
): GatewayServerOptions {
  const extras = attachedGatewayExtras.get(source);
  if (extras) {
    attachedGatewayExtras.set(target, extras);
  }
  return target;
}
