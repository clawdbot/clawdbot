import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Run `onDisconnect` once when the client goes away mid-stream.
 *
 * Listens on the response and the socket, NOT on the request: by the time an SSE
 * handler is streaming, the request body has been consumed, so `req` is already
 * complete and a `close` listener registered at that point never fires. The
 * socket outlives the request and is what actually signals an abandoned stream.
 *
 * Releasing promptly matters because an abandoned run holds its exclusive
 * per-session claim, which would otherwise block the next request until timeout.
 */
export function observeDisconnect(
  io: { req: IncomingMessage; res: ServerResponse },
  onDisconnect: () => void,
): void {
  let fired = false;
  const once = () => {
    if (fired) {
      return;
    }
    fired = true;
    onDisconnect();
  };
  io.res.on?.("close", once);
  io.req.socket?.once?.("close", once);
}
