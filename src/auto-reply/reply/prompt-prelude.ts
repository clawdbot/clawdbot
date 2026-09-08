/** Builds prompt body and envelope metadata for reply runs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CurrentInboundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { normalizeMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { MEDIA_ONLY_USER_TEXT } from "../../sessions/user-turn-media.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../heartbeat.js";
import { buildInboundMediaNoteProjection } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { appendChannelPromptContext } from "./channel-prompt-context.js";

const ROOM_EVENT_PROMPT = "[OpenClaw room event]";
const ROOM_EVENT_PARTICIPATION_RULE =
  "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking.";
const RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES = [
  "Conversation context (chronological, selected for current message):",
  "Chat history since last reply:",
];

/** Builds command/transcript/queued prompt bodies from inbound context. */
function buildReplyPromptBodies(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  effectiveBaseBody: string;
  prefixedBody?: string;
  transcriptBody?: string;
  inboundEventKind?: InboundEventKind;
  /** Facts whose text projection is already present in a body variant. */
  media?: readonly MediaFact[];
}): {
  mediaNote?: string;
  media?: MediaFact[];
  /** Original ctx.media positions; preprojected additions have no inbound index. */
  inboundMediaIndexes: readonly number[];
  prefixedCommandBody: string;
  queuedBody: string;
  transcriptCommandBody: string;
} {
  const prefixedBody = params.prefixedBody ?? params.effectiveBaseBody;
  const queueBodyBase = params.effectiveBaseBody;
  const generatedMedia = buildInboundMediaNoteProjection(params.ctx);
  const mediaNote = generatedMedia.text;
  const media = [...generatedMedia.media, ...normalizeMediaFacts(params.media)];
  const queuedBodyRaw = mediaNote
    ? [mediaNote, queueBodyBase].filter(Boolean).join("\n").trim()
    : queueBodyBase;
  const prefixedCommandBodyRaw = mediaNote
    ? [mediaNote, prefixedBody].filter(Boolean).join("\n").trim()
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
    inboundMediaIndexes: generatedMedia.mediaIndexes,
    ...(media.length > 0 ? { media } : {}),
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
type ReplyPromptEnvelope = ReturnType<typeof buildReplyPromptBodies> & ReplyPromptEnvelopeBase;

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
    normalizeOptionalString(params.ctx.commandText) ??
    normalizeOptionalString(params.sessionCtx.commandText) ??
    (params.hasUserBody ? params.baseBody.trim() : undefined) ??
    MEDIA_ONLY_USER_TEXT
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
      ? `${ROOM_EVENT_PARTICIPATION_RULE} To respond visibly, use message(action=send); your final text here stays private either way.`
      : ROOM_EVENT_PARTICIPATION_RULE;
  }
  if (
    params.inboundEventKind === "user_request" &&
    params.sourceReplyDeliveryMode === "message_tool_only"
  ) {
    return MESSAGE_TOOL_ONLY_DELIVERY_HINT;
  }
  return undefined;
}

// The current event itself is the user turn body; the context block carries
// only the marker, the room backlog, and the reply-policy directive so no
// fact is stated twice in one request.
function buildRoomEventContext(params: ReplyPromptEnvelopeBaseParams, roomContext: string): string {
  const roomContextBlock = roomContext.trim() ? `Room context:\n${roomContext.trim()}` : "";
  const deliveryDirective = resolvePerTurnDeliveryDirective(params);
  return [ROOM_EVENT_PROMPT, roomContextBlock, deliveryDirective].filter(Boolean).join("\n\n");
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
  const resumableRoomEventContext = isRoomEvent
    ? buildRoomEventContext(params, buildResumableRoomContext(inboundUserContext))
    : undefined;
  const currentInboundContextText = isRoomEvent
    ? buildRoomEventContext(params, inboundUserContext)
    : [inboundUserContext, resolvePerTurnDeliveryDirective(params)].filter(Boolean).join("\n\n");
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
  // Room-event turns and their transcript rows share one attributed chat line
  // so the active turn replays byte-identically as history; the room-event
  // marker and directive stay current-turn context only.
  const roomEventBody = isRoomEvent ? resolveRoomEventTranscriptBody(params) : undefined;
  const effectiveBaseBody =
    roomEventBody ?? (params.hasUserBody ? resetModelBody : MEDIA_ONLY_USER_TEXT);
  const transcriptBody = params.isHeartbeat
    ? HEARTBEAT_TRANSCRIPT_PROMPT
    : params.isBareSessionReset
      ? softResetTail || `[OpenClaw session ${params.startupAction}]`
      : (roomEventBody ?? (params.hasUserBody ? params.baseBody : MEDIA_ONLY_USER_TEXT));
  const deliveryDirective = resolvePerTurnDeliveryDirective(params);
  const fragments: RuntimeContextFragment[] = [
    ...(isRoomEvent ? [{ kind: "runtime-instruction" as const, text: ROOM_EVENT_PROMPT }] : []),
    ...(inboundUserContext
      ? [{ kind: "conversation-data" as const, text: inboundUserContext }]
      : []),
    ...(deliveryDirective
      ? [{ kind: "runtime-instruction" as const, text: deliveryDirective }]
      : []),
  ];
  const currentInboundContext: CurrentInboundPromptContext | undefined =
    !params.isBareSessionReset && currentInboundContextText
      ? {
          text: currentInboundContextText,
          fragments,
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
    /** Facts whose model-facing projection is already present in the supplied body. */
    media?: readonly MediaFact[];
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
    inboundEventKind: params.inboundEventKind,
    media: params.media,
  });

  const sourceContext = [
    params.threadContextNote,
    ...(params.systemEventBlocks ?? []),
    appendChannelPromptContext("", params.sessionCtx.ChannelPromptContext),
  ].filter((text): text is string => Boolean(text?.trim()));
  const currentInboundContext = sourceContext.length
    ? appendCurrentInboundContext(
        base.currentInboundContext,
        sourceContext.map((text) => ({ kind: "conversation-data", text })),
      )
    : base.currentInboundContext;
  return {
    ...promptBodies,
    ...base,
    currentInboundContext,
  };
}
