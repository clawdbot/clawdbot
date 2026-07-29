import type { BoardWidget } from "@openclaw/gateway-protocol";

type BoardWidgetTicketIdentity = object & Pick<BoardWidget, "viewTicket" | "viewTicketTtlMs">;

const ticketReceivedAtMs = new WeakMap<BoardWidgetTicketIdentity, number>();

export function recordBoardWidgetTicketReceipt(
  widget: BoardWidgetTicketIdentity,
  receivedAtMs = Date.now(),
): void {
  if (widget.viewTicket && widget.viewTicketTtlMs) {
    ticketReceivedAtMs.set(widget, receivedAtMs);
  }
}

export function copyBoardWidgetTicketReceipt(
  widget: BoardWidgetTicketIdentity,
  previous: BoardWidgetTicketIdentity,
  fallbackReceivedAtMs = Date.now(),
): void {
  if (widget.viewTicket && widget.viewTicketTtlMs) {
    ticketReceivedAtMs.set(widget, ticketReceivedAtMs.get(previous) ?? fallbackReceivedAtMs);
  }
}

export function remainingBoardWidgetTicketTtlMs(
  widget: BoardWidgetTicketIdentity,
  nowMs = Date.now(),
): number | undefined {
  const ttlMs = widget.viewTicketTtlMs;
  if (!widget.viewTicket || !ttlMs) {
    return undefined;
  }
  const receivedAtMs = ticketReceivedAtMs.get(widget);
  return receivedAtMs === undefined ? ttlMs : Math.max(0, ttlMs - (nowMs - receivedAtMs));
}
