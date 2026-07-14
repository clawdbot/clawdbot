/** Builds prompt body and envelope metadata for reply runs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CurrentInboundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../heartbeat.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { appendUntrustedContext } from "./untrusted-context.js";

const REPLY_MEDIA_HINT =
  "To send an image back, use the message tool with structured media fields such as media, mediaUrl, path, or filePath. Keep caption in the text body.";
const ROOM_EVENT_PROMPT = "[OpenClaw room event]";
const RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES = [
  "Conversation context (untrusted, chronological, selected for current message):",
  "Chat history since last reply (untrusted, for context):",
];

/** Builds command/transcript/queued prompt bodies from inbound context. */
export function buildReplyPromptBodies(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  effectiveBaseBody: string;
  prefixedBody?: string;
  transcriptBody?: string;
  threadContextNote?: string;
  systemEventBlocks?: string[];
  inboundEventKind?: InboundEventKind;
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
  const includeMediaTranscript = mediaNote && params.inboundEventKind !== "room_event";
  const transcriptCommandBodyRaw = transcriptBody
    ? includeMediaTranscript
      ? [mediaNote, transcriptBody].filter(Boolean).join("\n").trim()
      : transcriptBody
    : includeMediaTranscript
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
    transcriptCommandBody: transcriptCommandBodyRaw,
  };
}

/** Startup action associated with a reply prompt envelope. */
type ReplyPromptEnvelopeStartupAction = "new" | "reset";

/** Full prompt envelope passed into reply run preparation. */
type ReplyPromptEnvelope = ReturnType<typeof buildReplyPromptBodies> & {
  /** Model-visible body before media, thread context, and inter-session annotation are applied. */
  effectiveBaseBody: string;
  /** User-visible body persisted to transcript before media/inter-session annotation. */
  transcriptBody: string;
  /** Runtime-only user context for backends that can carry it outside transcript text. */
  currentInboundContext?: CurrentInboundPromptContext;
};

/** Base prompt envelope fields before body variants are added. */
type ReplyPromptEnvelopeBase = {
  /** Model-visible body before media, thread context, and inter-session annotation are applied. */
  effectiveBaseBody: string;
  /** User-visible body persisted to transcript before media/inter-session annotation. */
  transcriptBody: string;
  /** Runtime-only user context for backends that can carry it outside transcript text. */
  currentInboundContext?: CurrentInboundPromptContext;
};

type ReplyPromptEnvelopeBaseParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  baseBody: string;
  hasUserBody: boolean;
  inboundUserContext: string;
  activeGoalContext?: string;
  inboundUserContextPromptJoiner?: CurrentInboundPromptContext["promptJoiner"];
  isBareSessionReset: boolean;
  startupAction: ReplyPromptEnvelopeStartupAction;
  startupContextPrelude?: string | null;
  softResetTail?: string;
  isHeartbeat?: boolean;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
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

function resolveRoomEventTranscriptBody(params: ReplyPromptEnvelopeBaseParams): string {
  return (
    normalizeOptionalString(params.sessionCtx.AmbientTranscriptBody) ??
    normalizeOptionalString(params.ctx.AmbientTranscriptBody) ??
    formatRoomEventLine(params.sessionCtx, resolveRoomEventBody(params))
  );
}

function resolvePerTurnDeliveryDirective(params: {
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string | undefined {
  if (params.inboundEventKind === "room_event") {
    return params.sourceReplyDeliveryMode === "message_tool_only"
      ? "Treat this as observed room activity. Default: no reply; most room events need no response from you. Send a visible reply via message(action=send) only when you are directly addressed or have concrete value to add; your final text here stays private either way."
      : "Treat this as observed room activity. Default: no reply; most room events need no response from you. Reply only when you are directly addressed or have concrete value to add.";
  }
  if (
    params.inboundEventKind === "user_request" &&
    params.sourceReplyDeliveryMode === "message_tool_only"
  ) {
    return MESSAGE_TOOL_ONLY_DELIVERY_HINT;
  }
  return undefined;
}

function buildRoomEventContext(params: ReplyPromptEnvelopeBaseParams, roomContext: string): string {
  const roomEventBody = resolveRoomEventTranscriptBody(params);
  const roomContextBlock = roomContext.trim() ? `Room context:\n${roomContext.trim()}` : "";
  const deliveryDirective = resolvePerTurnDeliveryDirective(params);
  return [
    "[OpenClaw room event]",
    "inbound_event_kind: room_event",
    roomContextBlock,
    `Current event:\n${roomEventBody}`,
    deliveryDirective,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildResumableRoomContext(roomContext: string): string {
  return roomContext
    .split(/\n{2,}/u)
    .filter(
      (block) =>
        !RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES.some((prefix) => block.startsWith(prefix)),
    )
    .join("\n\n");
}

/** Builds prompt envelope metadata shared by all body variants. */
export function buildReplyPromptEnvelopeBase(
  params: ReplyPromptEnvelopeBaseParams,
): ReplyPromptEnvelopeBase {
  const softResetTail = params.softResetTail?.trim() ?? "";
  const isRoomEvent = params.inboundEventKind === "room_event";
  const inboundUserContext = params.inboundUserContext.trim();
  const roomEventContext = buildRoomEventContext(params, inboundUserContext);
  const resumableRoomEventContext = isRoomEvent
    ? buildRoomEventContext(params, buildResumableRoomContext(inboundUserContext))
    : undefined;
  const userRequestDeliveryDirective = resolvePerTurnDeliveryDirective({
    inboundEventKind: params.inboundEventKind,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
  });
  const currentInboundContextText = isRoomEvent
    ? roomEventContext
    : [inboundUserContext, userRequestDeliveryDirective].filter(Boolean).join("\n\n");
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
  // Room-event transcript rows are plain chat lines; replay treats them as
  // conversation, while the OpenClaw marker remains current-turn context only.
  const transcriptBody = params.isHeartbeat
    ? HEARTBEAT_TRANSCRIPT_PROMPT
    : params.isBareSessionReset
      ? softResetTail || `[OpenClaw session ${params.startupAction}]`
      : isRoomEvent
        ? resolveRoomEventTranscriptBody(params)
        : params.hasUserBody
          ? params.baseBody
          : "[User sent media without caption]";
  const currentInboundContext: CurrentInboundPromptContext | undefined =
    !params.isBareSessionReset && currentInboundContextText
      ? {
          text: currentInboundContextText,
          ...(resumableRoomEventContext ? { resumableText: resumableRoomEventContext } : {}),
          promptJoiner: params.inboundUserContextPromptJoiner,
          ...(params.activeGoalContext ? { injectedGoalContexts: [params.activeGoalContext] } : {}),
        }
      : undefined;

  return {
    effectiveBaseBody,
    transcriptBody,
    currentInboundContext,
  };
}

/** Builds the full reply prompt envelope for a prepared run. */
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
    inboundEventKind: params.inboundEventKind,
  });

  return {
    ...promptBodies,
    ...base,
  };
}
