/**
 * Background reflection triggered by negative user feedback (thumbs-down).
 *
 * Flow:
 * 1. User thumbs-down -> invoke handler acks immediately
 * 2. This module runs in the background (fire-and-forget)
 * 3. Reads recent session context
 * 4. Sends a synthetic reflection prompt to the agent
 * 5. Stores the derived learning in session
 * 6. Optionally sends a proactive follow-up to the user
 */

import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  dispatchReplyFromConfigWithSettledDispatcher,
  type OpenClawConfig,
} from "../runtime-api.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import { buildReflectionPrompt, parseReflectionResponse } from "./feedback-reflection-prompt.js";
import {
  DEFAULT_COOLDOWN_MS,
  clearReflectionCooldowns,
  isReflectionAllowed,
  loadSessionLearnings,
  recordReflectionTime,
  storeSessionLearning,
} from "./feedback-reflection-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { buildConversationReference } from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getMSTeamsRuntime } from "./runtime.js";

type FeedbackEvent = {
  type: "custom";
  event: "feedback";
  ts: number;
  messageId: string;
  value: "positive" | "negative";
  comment?: string;
  sessionKey: string;
  agentId: string;
  conversationId: string;
  reflectionLearning?: string;
};

export function buildFeedbackEvent(params: {
  messageId: string;
  value: "positive" | "negative";
  comment?: string;
  sessionKey: string;
  agentId: string;
  conversationId: string;
}): FeedbackEvent {
  return {
    type: "custom",
    event: "feedback",
    ts: Date.now(),
    messageId: params.messageId,
    value: params.value,
    comment: params.comment,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    conversationId: params.conversationId,
  };
}

type RunFeedbackReflectionParams = {
  cfg: OpenClawConfig;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  sessionKey: string;
  agentId: string;
  conversationId: string;
  feedbackMessageId: string;
  thumbedDownResponse?: string;
  userComment?: string;
  log: MSTeamsMonitorLogger;
};

function buildReflectionContext(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  sessionKey: string;
  reflectionPrompt: string;
}) {
  const core = getMSTeamsRuntime();
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(params.cfg);
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Teams",
    from: "system",
    body: params.reflectionPrompt,
    envelope: envelopeOptions,
  });

  return {
    ctxPayload: core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: params.reflectionPrompt,
      RawBody: params.reflectionPrompt,
      CommandBody: params.reflectionPrompt,
      From: `msteams:system:${params.conversationId}`,
      To: `conversation:${params.conversationId}`,
      SessionKey: params.sessionKey,
      ChatType: "direct" as const,
      SenderName: "system",
      SenderId: "system",
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: false,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: `conversation:${params.conversationId}`,
    }),
  };
}

function createReflectionCaptureDispatcher(params: {
  cfg: OpenClawConfig;
  agentId: string;
  log: MSTeamsMonitorLogger;
}) {
  const core = getMSTeamsRuntime();
  let response = "";
  const noopTypingCallbacks = {
    onReplyStart: async () => {},
    onIdle: () => {},
    onCleanup: () => {},
  };

  const { dispatcher, replyOptions } = core.channel.reply.createReplyDispatcherWithTyping({
    deliver: async (payload) => {
      if (payload.text) {
        response += (response ? "\n" : "") + payload.text;
      }
    },
    typingCallbacks: noopTypingCallbacks,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
    onError: (err) => {
      params.log.debug?.("reflection reply error", { error: formatUnknownError(err) });
    },
  });

  return {
    dispatcher,
    replyOptions,
    readResponse: () => response,
  };
}

async function sendReflectionFollowUp(params: {
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  userMessage: string;
}): Promise<void> {
  const baseRef = buildConversationReference(params.conversationRef);
  const proactiveRef = { ...baseRef, activityId: undefined };

  await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
    await ctx.sendActivity({
      type: "message",
      text: params.userMessage,
    });
  });
}

/**
 * Run a background reflection after negative feedback.
 * This is designed to be called fire-and-forget (don't await in the invoke handler).
 */
export async function runFeedbackReflection(params: RunFeedbackReflectionParams): Promise<void> {
  const { cfg, log, sessionKey } = params;
  const cooldownMs = cfg.channels?.msteams?.feedbackReflectionCooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (!isReflectionAllowed(sessionKey, cooldownMs)) {
    log.debug?.("skipping reflection (cooldown active)", { sessionKey });
    return;
  }

  const reflectionPrompt = buildReflectionPrompt({
    thumbedDownResponse: params.thumbedDownResponse,
    userComment: params.userComment,
  });
  const runtime = getMSTeamsRuntime();
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: params.agentId,
  });
  const { ctxPayload } = buildReflectionContext({
    cfg,
    conversationId: params.conversationId,
    sessionKey: params.sessionKey,
    reflectionPrompt,
  });

  const capture = createReflectionCaptureDispatcher({
    cfg,
    agentId: params.agentId,
    log,
  });

  try {
    await dispatchReplyFromConfigWithSettledDispatcher({
      ctxPayload,
      cfg,
      dispatcher: capture.dispatcher,
      onSettled: () => {},
      replyOptions: capture.replyOptions,
    });
  } catch (err) {
    log.error("reflection dispatch failed", { error: formatUnknownError(err) });
    return;
  }

  const reflectionResponse = capture.readResponse().trim();
  if (!reflectionResponse) {
    log.debug?.("reflection produced no output");
    return;
  }

  const parsedReflection = parseReflectionResponse(reflectionResponse);
  if (!parsedReflection) {
    log.debug?.("reflection produced no structured output");
    return;
  }

  recordReflectionTime(sessionKey, cooldownMs);
  log.info("reflection complete", {
    sessionKey,
    responseLength: reflectionResponse.length,
    followUp: parsedReflection.followUp,
  });

  try {
    await storeSessionLearning({
      storePath,
      sessionKey: params.sessionKey,
      learning: parsedReflection.learning,
    });
  } catch (err) {
    log.debug?.("failed to store reflection learning", { error: formatUnknownError(err) });
  }

  const conversationType = normalizeOptionalLowercaseString(
    params.conversationRef.conversation?.conversationType,
  );
  const shouldNotify =
    conversationType === "personal" &&
    parsedReflection.followUp &&
    Boolean(parsedReflection.userMessage);

  if (!shouldNotify) {
    if (parsedReflection.followUp && conversationType !== "personal") {
      log.debug?.("skipping reflection follow-up outside direct message", {
        sessionKey,
        conversationType,
      });
    }
    return;
  }

  try {
    await sendReflectionFollowUp({
      adapter: params.adapter,
      appId: params.appId,
      conversationRef: params.conversationRef,
      userMessage: parsedReflection.userMessage!,
    });
    log.info("sent reflection follow-up", { sessionKey });
  } catch (err) {
    log.debug?.("failed to send reflection follow-up", { error: formatUnknownError(err) });
  }
}

export {
  buildReflectionPrompt,
  clearReflectionCooldowns,
  isReflectionAllowed,
  loadSessionLearnings,
  parseReflectionResponse,
  recordReflectionTime,
};
