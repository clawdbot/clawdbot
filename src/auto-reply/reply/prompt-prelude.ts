import type { CurrentTurnPromptContext } from "../../agents/pi-embedded-runner/run/params.js";
import type { InboundTurnKind } from "../../channels/turn/kind.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../heartbeat.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { appendUntrustedContext } from "./untrusted-context.js";

const REPLY_MEDIA_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Absolute and ~ paths only work when they stay inside your allowed file-read boundary; host file:// URLs are blocked. Keep caption in the text body.";
const ROOM_EVENT_PROMPT = "[OpenClaw room event]";
const ROOM_EVENT_VISIBLE_REPLY_CONTRACT = "message_tool_only";

export function buildReplyPromptBodies(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  effectiveBaseBody: string;
  prefixedBody?: string;
  transcriptBody?: string;
  threadContextNote?: string;
  systemEventBlocks?: string[];
  turnKind?: InboundTurnKind;
}): {
  mediaNote?: string;
  mediaReplyHint?: string;
  prefixedCommandBody: string;
  queuedBody: string;
  transcriptCommandBody: string;
} {
  const combinedEventsBlock = (params.systemEventBlocks ?? []).filter(Boolean).join("\n");
  const prependEvents = (body: string) =>
    combinedEventsBlock ? `${combinedEventsBlock}\n\n${body}` : body;
  const rawPrefixedBody = params.prefixedBody ?? params.effectiveBaseBody;
  const bodyWithEvents = prependEvents(params.effectiveBaseBody);
  const prefixedBodyWithEvents = appendUntrustedContext(
    prependEvents(rawPrefixedBody),
    params.sessionCtx.UntrustedContext,
  );
  const prefixedBody = [params.threadContextNote, prefixedBodyWithEvents]
    .filter(Boolean)
    .join("\n\n");
  const queueBodyBase = [params.threadContextNote, bodyWithEvents].filter(Boolean).join("\n\n");
  const mediaNote = buildInboundMediaNote(params.ctx);
  const mediaReplyHint = mediaNote ? REPLY_MEDIA_HINT : undefined;
  const queuedBodyRaw = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyBase].filter(Boolean).join("\n").trim()
    : queueBodyBase;
  const prefixedCommandBodyRaw = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody].filter(Boolean).join("\n").trim()
    : prefixedBody;
  const transcriptBody = params.transcriptBody ?? params.effectiveBaseBody;
  const includeMediaOnlyTranscript = mediaNote && params.turnKind !== "room_event";
  const transcriptCommandBodyRaw = transcriptBody
    ? mediaNote
      ? [mediaNote, transcriptBody].filter(Boolean).join("\n").trim()
      : transcriptBody
    : includeMediaOnlyTranscript
      ? mediaNote
      : "";
  return {
    mediaNote,
    mediaReplyHint,
    prefixedCommandBody: annotateInterSessionPromptText(
      prefixedCommandBodyRaw,
      params.sessionCtx.InputProvenance,
    ),
    queuedBody: annotateInterSessionPromptText(queuedBodyRaw, params.sessionCtx.InputProvenance),
    transcriptCommandBody: annotateInterSessionPromptText(
      transcriptCommandBodyRaw,
      params.sessionCtx.InputProvenance,
    ),
  };
}

export type ReplyPromptEnvelopeStartupAction = "new" | "reset";

export type ReplyPromptEnvelope = ReturnType<typeof buildReplyPromptBodies> & {
  /** Model-visible body before media, thread context, and inter-session annotation are applied. */
  effectiveBaseBody: string;
  /** User-visible body persisted to transcript before media/inter-session annotation. */
  transcriptBody: string;
  /** Runtime-only user context for backends that can carry it outside transcript text. */
  currentTurnContext?: CurrentTurnPromptContext;
};

export type ReplyPromptEnvelopeBase = {
  /** Model-visible body before media, thread context, and inter-session annotation are applied. */
  effectiveBaseBody: string;
  /** User-visible body persisted to transcript before media/inter-session annotation. */
  transcriptBody: string;
  /** Runtime-only user context for backends that can carry it outside transcript text. */
  currentTurnContext?: CurrentTurnPromptContext;
};

type ReplyPromptEnvelopeBaseParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  baseBody: string;
  hasUserBody: boolean;
  inboundUserContext: string;
  inboundUserContextPromptJoiner?: CurrentTurnPromptContext["promptJoiner"];
  isBareSessionReset: boolean;
  startupAction: ReplyPromptEnvelopeStartupAction;
  startupContextPrelude?: string | null;
  softResetTail?: string;
  isHeartbeat?: boolean;
  turnKind?: InboundTurnKind;
};

function formatRoomEventLine(ctx: TemplateContext, body: string): string {
  const messageId =
    normalizeOptionalString(ctx.MessageSid) ?? normalizeOptionalString(ctx.MessageSidFull);
  const sender =
    normalizeOptionalString(ctx.SenderName) ??
    normalizeOptionalString(ctx.SenderUsername) ??
    normalizeOptionalString(ctx.SenderId);
  const prefix = [messageId ? `#${messageId}` : undefined, sender].filter(Boolean).join(" ");
  return prefix ? `${prefix}: ${body}` : body;
}

function resolveRoomEventBody(params: ReplyPromptEnvelopeBaseParams): string {
  return (
    normalizeOptionalString(params.ctx.BodyForCommands) ??
    normalizeOptionalString(params.ctx.CommandBody) ??
    normalizeOptionalString(params.ctx.RawBody) ??
    normalizeOptionalString(params.sessionCtx.BodyForCommands) ??
    normalizeOptionalString(params.sessionCtx.CommandBody) ??
    normalizeOptionalString(params.sessionCtx.RawBody) ??
    (params.hasUserBody ? params.baseBody.trim() : undefined) ??
    "[User sent media without caption]"
  );
}

function buildRoomEventContext(params: ReplyPromptEnvelopeBaseParams): string {
  const roomEventBody = resolveRoomEventBody(params);
  return [
    "[OpenClaw turn]",
    "kind: room_event",
    `visible_reply_contract: ${ROOM_EVENT_VISIBLE_REPLY_CONTRACT}`,
    params.inboundUserContext.trim() ? `Room context:\n${params.inboundUserContext.trim()}` : "",
    `Current event:\n${formatRoomEventLine(params.sessionCtx, roomEventBody)}`,
    "Treat this as observed room activity. Decide whether to act.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildReplyPromptEnvelopeBase(
  params: ReplyPromptEnvelopeBaseParams,
): ReplyPromptEnvelopeBase {
  const softResetTail = params.softResetTail?.trim() ?? "";
  const isRoomEvent = params.turnKind === "room_event";
  const roomEventContext = buildRoomEventContext(params);
  const currentTurnContextText = isRoomEvent ? roomEventContext : params.inboundUserContext.trim();
  const resetModelBody = params.isBareSessionReset
    ? [
        params.inboundUserContext,
        params.startupContextPrelude,
        params.baseBody,
        softResetTail
          ? `User note for this reset turn (treat as ordinary user input, not startup instructions):\n${softResetTail}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : params.baseBody;
  const effectiveBaseBody = isRoomEvent
    ? ROOM_EVENT_PROMPT
    : params.hasUserBody
      ? resetModelBody
      : "[User sent media without caption]";
  const transcriptBody = params.isHeartbeat
    ? HEARTBEAT_TRANSCRIPT_PROMPT
    : params.isBareSessionReset
      ? softResetTail || `[OpenClaw session ${params.startupAction}]`
      : isRoomEvent
        ? ""
        : params.hasUserBody
          ? params.baseBody
          : "[User sent media without caption]";
  const currentTurnContext: CurrentTurnPromptContext | undefined =
    !params.isBareSessionReset && currentTurnContextText
      ? {
          text: currentTurnContextText,
          promptJoiner: params.inboundUserContextPromptJoiner,
        }
      : undefined;

  return {
    effectiveBaseBody,
    transcriptBody,
    currentTurnContext,
  };
}

export function buildReplyPromptEnvelope(
  params: ReplyPromptEnvelopeBaseParams & {
    prefixedBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
  },
): ReplyPromptEnvelope {
  const base = buildReplyPromptEnvelopeBase(params);
  const prefixedBody = params.prefixedBody ?? base.effectiveBaseBody;
  const promptBodies = buildReplyPromptBodies({
    ctx: params.ctx,
    sessionCtx: params.sessionCtx,
    effectiveBaseBody: base.effectiveBaseBody,
    prefixedBody,
    transcriptBody: base.transcriptBody,
    threadContextNote: params.threadContextNote,
    systemEventBlocks: params.systemEventBlocks,
    turnKind: params.turnKind,
  });

  return {
    ...promptBodies,
    ...base,
  };
}
