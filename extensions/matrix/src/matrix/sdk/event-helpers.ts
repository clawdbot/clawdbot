import type { MatrixEvent } from "matrix-js-sdk";
import type { MatrixRawEvent } from "./types.js";

export function matrixEventToRaw(event: MatrixEvent): MatrixRawEvent {
  const unsigned = (event.getUnsigned?.() ?? {}) as {
    age?: number;
    redacted_because?: unknown;
  };
  const raw: MatrixRawEvent = {
    event_id: event.getId() ?? "",
    sender: event.getSender() ?? "",
    type: event.getType() ?? "",
    origin_server_ts: event.getTs() ?? 0,
    content: (event.getContent?.() ?? {}) || {},
    unsigned,
  };
  const stateKey = resolveMatrixStateKey(event);
  if (typeof stateKey === "string") {
    raw.state_key = stateKey;
  }
  return raw;
}

export function parseMxc(url: string): { server: string; mediaId: string } | null {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(url.trim());
  if (!match) {
    return null;
  }
  return {
    server: match[1],
    mediaId: match[2],
  };
}

export function buildHttpError(
  statusCode: number,
  bodyText: string,
): Error & { statusCode: number } {
  let message = `Matrix HTTP ${statusCode}`;
  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        message = parsed.error.trim();
      } else {
        message = bodyText.slice(0, 500);
      }
    } catch {
      message = bodyText.slice(0, 500);
    }
  }
  return Object.assign(new Error(message), { statusCode });
}

function resolveMatrixStateKey(event: MatrixEvent): string | undefined {
  const direct = event.getStateKey?.();
  if (typeof direct === "string") {
    return direct;
  }
  const wireContent = (
    event as { getWireContent?: () => { state_key?: unknown } }
  ).getWireContent?.();
  if (wireContent && typeof wireContent.state_key === "string") {
    return wireContent.state_key;
  }
  const rawEvent = (event as { event?: { state_key?: unknown } }).event;
  if (rawEvent && typeof rawEvent.state_key === "string") {
    return rawEvent.state_key;
  }
  return undefined;
}
