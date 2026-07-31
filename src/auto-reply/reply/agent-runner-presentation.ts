import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { logVerbose } from "../../globals.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";

type AgentTurnPresentation = {
  normalizeStreamingText: (payload: ReplyPayload) => { text?: string; skip: boolean };
  preparePartialForTyping: (payload: ReplyPayload) => string | undefined;
  handlePartialForTyping: (payload: ReplyPayload) => Promise<string | undefined>;
  startPresentationWhileTyping: (
    typingPromise: Promise<void>,
    startPresentation: () => void | Promise<void>,
  ) => Promise<void>;
  blockReplyHandler: ReturnType<typeof createBlockReplyDeliveryHandler> | undefined;
};

/** Builds the channel-presentation callbacks shared by CLI and embedded runs. */
export function createAgentTurnPresentation(params: {
  turn: AgentTurnParams;
  replyMediaContext: ReplyMediaContext;
  directlySentBlockKeys: Set<string>;
  directlySentBlockPayloads: Array<ReplyPayload | undefined>;
  heartbeatState: { didLogStrip: boolean };
}): AgentTurnPresentation {
  const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
    let text = payload.text;
    const reply = resolveSendableOutboundReplyParts(payload);
    if (params.turn.followupRun.run.silentExpected) {
      return { skip: true };
    }
    if (!params.turn.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
      const stripped = stripHeartbeatToken(text, { mode: "message" });
      if (stripped.didStrip && !params.heartbeatState.didLogStrip) {
        params.heartbeatState.didLogStrip = true;
        logVerbose("Stripped stray HEARTBEAT_OK token from reply");
      }
      if (stripped.shouldSkip && !reply.hasMedia) {
        return { skip: true };
      }
      text = stripped.text;
    }
    if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      return { skip: true };
    }
    if (
      isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
      isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
    ) {
      return { skip: true };
    }
    if (text && startsWithSilentToken(text, SILENT_REPLY_TOKEN)) {
      text = stripLeadingSilentToken(text, SILENT_REPLY_TOKEN);
    }
    if (!text) {
      return reply.hasMedia ? { text: undefined, skip: false } : { skip: true };
    }
    const sanitized = sanitizeUserFacingText(text, {
      errorContext: Boolean(payload.isError),
    });
    return sanitized.trim() ? { text: sanitized, skip: false } : { skip: true };
  };

  const preparePartialForTyping = (payload: ReplyPayload): string | undefined => {
    if (isSilentReplyPrefixText(payload.text, SILENT_REPLY_TOKEN)) {
      return undefined;
    }
    const { text, skip } = normalizeStreamingText(payload);
    return skip || !text ? undefined : text;
  };

  const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
    const text = preparePartialForTyping(payload);
    if (text === undefined) {
      return undefined;
    }
    await params.turn.typingSignals.signalTextDelta(text);
    return text;
  };

  const startPresentationWhileTyping = async (
    typingPromise: Promise<void>,
    startPresentation: () => void | Promise<void>,
  ) => {
    let presentationPromise: void | Promise<void>;
    try {
      presentationPromise = startPresentation();
    } catch (err) {
      // Typing already started; observe a secondary failure if presentation throws inline.
      void typingPromise.catch(() => undefined);
      throw err;
    }
    await Promise.all([typingPromise, presentationPromise]);
  };

  const blockReplyPipeline = params.turn.blockReplyPipeline;
  // One handler owns threading and direct-send dedupe for this fallback cycle.
  const blockReplyHandler = params.turn.opts?.onBlockReply
    ? createBlockReplyDeliveryHandler({
        onBlockReply: params.turn.opts.onBlockReply,
        currentMessageId:
          params.turn.sessionCtx.MessageSidFull ?? params.turn.sessionCtx.MessageSid,
        replyThreading: params.turn.replyThreading,
        normalizeStreamingText,
        applyReplyToMode: params.turn.applyReplyToMode,
        normalizeMediaPaths: params.replyMediaContext.normalizePayload,
        typingSignals: params.turn.typingSignals,
        reasoningPayloadsEnabled: params.turn.opts?.reasoningPayloadsEnabled,
        commentaryPayloadsEnabled: params.turn.opts?.commentaryPayloadsEnabled,
        blockStreamingEnabled: params.turn.blockStreamingEnabled,
        blockReplyPipeline,
        directlySentBlockKeys: params.directlySentBlockKeys,
        directlySentBlockPayloads: params.directlySentBlockPayloads,
      })
    : undefined;

  return {
    normalizeStreamingText,
    preparePartialForTyping,
    handlePartialForTyping,
    startPresentationWhileTyping,
    blockReplyHandler,
  };
}
