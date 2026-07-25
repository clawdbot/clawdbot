// Msteams plugin module implements feedback reflection behavior.
import {
  DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS,
  runChannelFeedbackReflection,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveMSTeamsSdkCloudOptions } from "./cloud.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import { storeSessionLearning } from "./feedback-reflection-store.js";
import { buildConversationReference } from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";

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
  app: MSTeamsApp;
  conversationRef: StoredConversationReference;
  sessionKey: string;
  agentId: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "channel";
  thumbedDownResponse?: string;
  userComment?: string;
  log: MSTeamsMonitorLogger;
};

/**
 * Run a background reflection after negative feedback.
 * This is designed to be called fire-and-forget (don't await in the invoke handler).
 */
export async function runFeedbackReflection(params: RunFeedbackReflectionParams): Promise<void> {
  const { cfg, log, sessionKey } = params;
  const cooldownMs =
    cfg.channels?.msteams?.feedbackReflectionCooldownMs ??
    DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS;
  let reflection;
  try {
    reflection = await runChannelFeedbackReflection({
      cfg,
      channel: "msteams",
      channelLabel: "Teams",
      agentId: params.agentId,
      sessionKey,
      conversationId: params.conversationId,
      conversationKind: params.conversationKind,
      thumbedDownResponse: params.thumbedDownResponse,
      userComment: params.userComment,
      cooldownMs,
      onRecordError: (err) =>
        log.debug?.("reflection session record failed", { error: formatUnknownError(err) }),
      onDispatchError: (err) =>
        log.debug?.("reflection reply error", { error: formatUnknownError(err) }),
    });
  } catch (err) {
    log.error("reflection dispatch failed", { error: formatUnknownError(err) });
    return;
  }
  if (reflection.status === "cooldown") {
    log.debug?.("skipping reflection (cooldown active)", { sessionKey });
    return;
  }
  if (reflection.status === "empty") {
    log.debug?.("reflection produced no output");
    return;
  }
  log.info("reflection complete", {
    sessionKey,
    responseLength: reflection.responseLength,
    followUp: reflection.followUp,
  });
  try {
    await storeSessionLearning({
      storePath: reflection.storePath,
      sessionKey,
      learning: reflection.learning,
    });
  } catch (err) {
    log.debug?.("failed to store reflection learning", { error: formatUnknownError(err) });
  }

  const conversationType = normalizeOptionalLowercaseString(
    params.conversationRef.conversation?.conversationType,
  );
  const shouldNotify =
    conversationType === "personal" && reflection.followUp && Boolean(reflection.userMessage);

  if (!shouldNotify) {
    if (reflection.followUp && conversationType !== "personal") {
      log.debug?.("skipping reflection follow-up outside direct message", {
        sessionKey,
        conversationType,
      });
    }
    return;
  }

  try {
    await sendMSTeamsActivityWithReference(
      params.app,
      buildConversationReference(params.conversationRef),
      { type: "message", text: reflection.userMessage! },
      { serviceUrlBoundary: resolveMSTeamsSdkCloudOptions(cfg.channels?.msteams) },
    );
    log.info("sent reflection follow-up", { sessionKey });
  } catch (err) {
    log.debug?.("failed to send reflection follow-up", { error: formatUnknownError(err) });
  }
}
