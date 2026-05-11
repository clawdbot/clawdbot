import type { CurrentTurnPromptContext } from "../../agents/pi-embedded-runner/run/params.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../heartbeat.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { appendUntrustedContext } from "./untrusted-context.js";

const REPLY_MEDIA_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Absolute and ~ paths only work when they stay inside your allowed file-read boundary; host file:// URLs are blocked. Keep caption in the text body.";

export function buildReplyPromptBodies(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  effectiveBaseBody: string;
  prefixedBody?: string;
  transcriptBody?: string;
  threadContextNote?: string;
  systemEventBlocks?: string[];
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
  const transcriptCommandBodyRaw = mediaNote
    ? [mediaNote, transcriptBody].filter(Boolean).join("\n").trim()
    : transcriptBody;
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
};

export function buildReplyPromptEnvelopeBase(
  params: ReplyPromptEnvelopeBaseParams,
): ReplyPromptEnvelopeBase {
  const softResetTail = params.softResetTail?.trim() ?? "";
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
  const effectiveBaseBody = params.hasUserBody
    ? resetModelBody
    : "[User sent media without caption]";
  const transcriptBody = params.isHeartbeat
    ? HEARTBEAT_TRANSCRIPT_PROMPT
    : params.isBareSessionReset
      ? softResetTail || `[OpenClaw session ${params.startupAction}]`
      : params.hasUserBody
        ? params.baseBody
        : "[User sent media without caption]";
  const currentTurnContext: CurrentTurnPromptContext | undefined =
    !params.isBareSessionReset && params.inboundUserContext.trim()
      ? {
          text: params.inboundUserContext,
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
  });

  return {
    ...promptBodies,
    ...base,
  };
}
