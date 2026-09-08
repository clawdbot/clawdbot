import {
  buildAssistantMediaUrl,
  type AssistantMediaContext,
} from "../../../app/assistant-media.ts";

export function isLocalAssistantAttachmentSource(source: string): boolean {
  const trimmed = source.trim();
  if (/^\/(?:__openclaw__|media|api\/chat\/media\/outgoing)\//.test(trimmed)) {
    return false;
  }
  return (
    isCanonicalInboundMediaSource(trimmed) ||
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

export function isCanonicalInboundMediaSource(source: string): boolean {
  // Match the raw one-segment form first; URL parsing would erase dot segments.
  const match = /^media:\/\/inbound\/([^/?#]+)$/i.exec(source.trim());
  if (!match?.[1]) {
    return false;
  }
  try {
    const id = decodeURIComponent(match[1]);
    return (
      id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0")
    );
  } catch {
    return false;
  }
}

export function buildAssistantAttachmentUrl(
  source: string,
  resourceBasePath?: string,
  mediaTicket?: string | null,
  context?: AssistantMediaContext,
): string {
  if (!isLocalAssistantAttachmentSource(source)) {
    return source;
  }
  return buildAssistantMediaUrl(source, resourceBasePath, mediaTicket, context);
}

export function appendAttachmentUrlSearchParam(
  source: string,
  name: string,
  value: string,
): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }
  const hashIndex = trimmed.indexOf("#");
  const hash = hashIndex === -1 ? "" : trimmed.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1));
  params.set(name, value);
  return `${path}?${params.toString()}${hash}`;
}
