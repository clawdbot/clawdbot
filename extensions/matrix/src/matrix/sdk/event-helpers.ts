import type { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import type { MatrixRawEvent } from "./types.js";

type MatrixEventContentMode = "current" | "original";

export function matrixEventToRaw(
  event: MatrixEvent,
  opts: { contentMode?: MatrixEventContentMode } = {},
): MatrixRawEvent {
  const unsigned = (event.getUnsigned?.() ?? {}) as {
    age?: number;
    redacted_because?: unknown;
  };
  const eventWithOriginalContent = event as {
    getOriginalContent?: () => Record<string, unknown>;
  };
  const content =
    opts.contentMode === "original"
      ? (eventWithOriginalContent.getOriginalContent?.() ?? event.getContent?.() ?? {})
      : (event.getContent?.() ?? eventWithOriginalContent.getOriginalContent?.() ?? {});
  const raw: MatrixRawEvent = {
    event_id: event.getId() ?? "",
    sender: event.getSender() ?? "",
    type: event.getType() ?? "",
    origin_server_ts: event.getTs() ?? 0,
    content: content || {},
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
