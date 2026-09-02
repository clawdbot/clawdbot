// Matrix helper module supports event helpers behavior.
import type { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { MatrixRawEvent } from "./types.js";

type MatrixEventContentMode = "current" | "original";

export function matrixEventToRaw(
  event: MatrixEvent,
  opts: { contentMode?: MatrixEventContentMode } = {},
): MatrixRawEvent {
  const originalContent = event.getOriginalContent<Record<string, unknown>>();
  const content = (
    opts.contentMode === "original" ? originalContent : event.getContent<Record<string, unknown>>()
  ) as Record<string, unknown>;
  const relation = originalContent["m.relates_to"] || event.getWireContent()["m.relates_to"];
  const normalizedContent =
    relation && !Object.hasOwn(content, "m.relates_to")
      ? { ...content, "m.relates_to": relation }
      : content;
  const raw: MatrixRawEvent = {
    event_id: event.getId() ?? "",
    sender: event.getSender() ?? "",
    type: event.getType() ?? "",
    origin_server_ts: event.getTs() ?? 0,
    content: normalizedContent,
    unsigned: event.getUnsigned(),
  };
  const stateKey = event.getStateKey() ?? event.getWireStateKey();
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
  const server = match[1];
  const mediaId = match[2];
  if (!server || !mediaId) {
    return null;
  }
  return {
    server,
    mediaId,
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
        message = truncateUtf16Safe(bodyText, 500);
      }
    } catch {
      message = truncateUtf16Safe(bodyText, 500);
    }
  }
  return Object.assign(new Error(message), { statusCode });
}
