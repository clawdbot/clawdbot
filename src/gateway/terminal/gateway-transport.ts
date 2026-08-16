import type {
  GatewayBroadcastToConnIdsFn,
  GatewayBufferedAmountFn,
} from "../server-broadcast-types.js";

export const TERMINAL_EVENT_DATA = "terminal.data" as const;
export const TERMINAL_EVENT_EXIT = "terminal.exit" as const;

/** Adapts terminal ownership to targeted gateway delivery and pressure state. */
export function createTerminalSessionTransport(
  broadcastToConnIds: GatewayBroadcastToConnIdsFn,
  getBufferedAmount: GatewayBufferedAmountFn,
) {
  return {
    emit: (connId: string, event: string, payload: unknown) =>
      broadcastToConnIds(event, payload, new Set([connId]), {
        // PTY flow control is primary; dropping is the last-resort socket cap guard.
        dropIfSlow: event === TERMINAL_EVENT_DATA,
      }),
    getBufferedAmount,
  };
}
