import type { CaptureEventView } from "./ui-types.js";

export function captureEventKey(
  event: Pick<CaptureEventView, "id" | "flowId" | "ts" | "kind">,
): string {
  return `${event.id ?? "no-id"}:${event.flowId}:${event.ts}:${event.kind}`;
}

export function captureEventGlyph(event: Pick<CaptureEventView, "kind" | "direction">): {
  label: string;
  cls: string;
} {
  switch (event.kind) {
    case "request":
      return { label: "REQ", cls: "req" };
    case "response":
      return { label: "RES", cls: "res" };
    case "error":
      return { label: "ERR", cls: "err" };
    case "ws-frame":
      return { label: "WS", cls: "ws" };
    case "ws-open":
      return { label: "W+", cls: "ws" };
    case "ws-close":
      return { label: "W-", cls: "ws" };
    case "tls-handshake":
      return { label: "TLS", cls: "sys" };
    case "connect":
      return { label: "CON", cls: "sys" };
    case "retry-link":
      return { label: "RTY", cls: "warn" };
    default:
      return { label: event.direction === "inbound" ? "IN" : "OUT", cls: "sys" };
  }
}

export function findPairedCaptureEvent(
  event: CaptureEventView | null,
  candidates: CaptureEventView[],
): { counterpart: CaptureEventView | null; role: "request" | "response" | null } {
  if (!event?.flowId || (event.kind !== "request" && event.kind !== "response")) {
    return { counterpart: null, role: null };
  }
  const flowEvents = candidates
    .filter(
      (candidate) =>
        candidate.flowId === event.flowId &&
        (candidate.kind === "request" || candidate.kind === "response") &&
        captureEventKey(candidate) !== captureEventKey(event),
    )
    .toSorted(
      (left, right) =>
        left.ts - right.ts || captureEventKey(left).localeCompare(captureEventKey(right)),
    );
  if (event.kind === "request") {
    return {
      counterpart:
        flowEvents.find((candidate) => candidate.kind === "response" && candidate.ts >= event.ts) ??
        null,
      role: "response",
    };
  }
  const requests = flowEvents.filter(
    (candidate) => candidate.kind === "request" && candidate.ts <= event.ts,
  );
  return {
    counterpart: requests.at(-1) ?? null,
    role: "request",
  };
}
