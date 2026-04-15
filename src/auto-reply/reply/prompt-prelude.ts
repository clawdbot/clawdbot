import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { appendUntrustedContext } from "./untrusted-context.js";

export const REPLY_MEDIA_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Absolute and ~ paths only work when they stay inside your allowed file-read boundary; host file:// URLs are blocked. Keep caption in the text body.";

export function buildReplyPromptBodies(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  effectiveBaseBody: string;
  prefixedBody: string;
  threadContextNote?: string;
  systemEventBlocks?: string[];
}): {
  mediaNote?: string;
  mediaReplyHint?: string;
  prefixedCommandBody: string;
  queuedBody: string;
} {
  const combinedEventsBlock = (params.systemEventBlocks ?? []).filter(Boolean).join("\n");
  const prependEvents = (body: string) =>
    combinedEventsBlock ? `${combinedEventsBlock}\n\n${body}` : body;
  const bodyWithEvents = prependEvents(params.effectiveBaseBody);
  const prefixedBodyWithEvents = appendUntrustedContext(
    prependEvents(params.prefixedBody),
    params.sessionCtx.UntrustedContext,
  );
  const prefixedBody = [params.threadContextNote, prefixedBodyWithEvents]
    .filter(Boolean)
    .join("\n\n");
  const queueBodyBase = [params.threadContextNote, bodyWithEvents].filter(Boolean).join("\n\n");
  const mediaNote = buildInboundMediaNote(params.ctx);
  const mediaReplyHint = mediaNote ? REPLY_MEDIA_HINT : undefined;
  const queuedBody = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyBase].filter(Boolean).join("\n").trim()
    : queueBodyBase;
  const prefixedCommandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody].filter(Boolean).join("\n").trim()
    : prefixedBody;
  return {
    mediaNote,
    mediaReplyHint,
    prefixedCommandBody,
    queuedBody,
  };
}
