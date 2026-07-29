// Lazily loads one gateway handler without changing its request contract.
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./server-methods/types.js";

export function createLazyHandler(
  method: string,
  loadHandlers: () => Promise<GatewayRequestHandlers>,
): GatewayRequestHandler {
  return async (opts) => {
    const handler = (await loadHandlers())[method];
    if (!handler) {
      throw new Error(`lazy gateway handler not found: ${method}`);
    }
    await handler(opts);
  };
}
