// Msteams plugin module implements feedback invoke behavior.
import { recordChannelFeedbackEvent } from "openclaw/plugin-sdk/channel-inbound";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { formatUnknownError } from "./errors.js";
import { buildFeedbackEvent, runFeedbackReflection } from "./feedback-reflection.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { isFeedbackInvokeAuthorized } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

/**
 * Run the message-submit (feedback) invoke handler.
 *
 * Teams delivers feedback (`actionName === "feedback"`) on AI-generated
 * messages as a `message/submitAction` invoke. The SDK wraps a void return
 * into the HTTP 200 InvokeResponse, so this function intentionally does
 * not ack itself — the legacy `ctx.sendActivity({ type: "invokeResponse",
 * … })` shape is gone (it became an outbound BF activity on the new SDK
 * instead of the HTTP response).
 *
 * Returns `true` if the invoke matched the feedback shape and was
 * consumed (whether or not it was authorized / written / reflected on),
 * `false` if the invoke didn't look like feedback at all and the caller
 * should fall through to other handlers.
 */
export async function runMSTeamsFeedbackInvokeHandler(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  const activity = context.activity;
  const value = activity.value as
    | {
        actionName?: string;
        actionValue?: { reaction?: string; feedback?: string };
        replyToId?: string;
      }
    | undefined;

  if (!value) {
    return false;
  }

  // Teams feedback invoke format: actionName="feedback", actionValue.reaction="like"|"dislike"
  if (value.actionName !== "feedback") {
    return false;
  }

  const reaction = value.actionValue?.reaction;
  if (reaction !== "like" && reaction !== "dislike") {
    deps.log.debug?.("ignoring feedback with unknown reaction", { reaction });
    return false;
  }

  const msteamsCfg = resolveMSTeamsAccountConfig(deps.cfg, deps.accountId);
  if (msteamsCfg?.feedbackEnabled === false) {
    deps.log.debug?.("feedback handling disabled");
    return true; // Still consume the invoke
  }

  if (!(await isFeedbackInvokeAuthorized(context, deps))) {
    return true;
  }

  // Extract user comment from the nested JSON string
  let userComment: string | undefined;
  if (value.actionValue?.feedback) {
    try {
      const parsed = JSON.parse(value.actionValue.feedback) as { feedbackText?: string };
      userComment = parsed.feedbackText || undefined;
    } catch {
      // Best effort — feedback text is optional
    }
  }

  // Strip ;messageid=... suffix to match the normalized ID used by the message handler.
  const rawConversationId = activity.conversation?.id ?? "unknown";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const messageId = value.replyToId ?? activity.replyToId ?? "unknown";
  const isNegative = reaction === "dislike";

  // Route feedback using the same chat-type logic as normal messages
  // so session keys, agent IDs, and transcript paths match.
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const isChannel = convType === "channel";

  const core = getMSTeamsRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: "msteams",
    accountId: deps.accountId,
    peer: {
      kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      id: isDirectMessage ? senderId : conversationId,
    },
  });

  // Match the thread-aware session key used by the message handler so feedback
  // events land in the correct per-thread transcript. For channel threads, the
  // thread root ID comes from the ;messageid= suffix on the conversation ID or
  // from activity.replyToId.
  const feedbackThreadId = isChannel
    ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId ?? undefined)
    : undefined;
  if (feedbackThreadId) {
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey: route.sessionKey,
      threadId: feedbackThreadId,
      parentSessionKey: route.sessionKey,
    });
    route.sessionKey = threadKeys.sessionKey;
  }

  // Log feedback event to session JSONL
  const feedbackEvent = buildFeedbackEvent({
    messageId,
    value: isNegative ? "negative" : "positive",
    comment: userComment,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    conversationId,
  });

  deps.log.info("received feedback", {
    value: feedbackEvent.value,
    messageId,
    conversationId,
    hasComment: Boolean(userComment),
  });

  try {
    await recordChannelFeedbackEvent({
      cfg: deps.cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      event: feedbackEvent,
    });
  } catch {
    // Best effort
  }

  // Build conversation reference for proactive messages (ack + reflection follow-up)
  const conversationRef = {
    activityId: activity.id,
    user: {
      id: activity.from?.id,
      name: activity.from?.name,
      aadObjectId: activity.from?.aadObjectId,
    },
    agent: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    conversation: {
      id: conversationId,
      conversationType: activity.conversation?.conversationType,
      tenantId: activity.conversation?.tenantId,
    },
    channelId: activity.channelId ?? "msteams",
    serviceUrl: activity.serviceUrl,
    locale: activity.locale,
  };

  // For negative feedback, trigger background reflection (fire-and-forget).
  // No ack message — the reflection follow-up serves as the acknowledgement.
  // Sending anything during the invoke handler causes "unable to reach app" errors.
  if (isNegative && msteamsCfg?.feedbackReflection !== false) {
    // Note: thumbedDownResponse is not populated here because we don't cache
    // sent message text. The agent still has full session context for reflection
    // since the reflection runs in the same session. The user comment (if any)
    // provides additional signal.
    runFeedbackReflection({
      cfg: deps.cfg,
      app: deps.app,
      accountId: deps.accountId,
      conversationRef,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      conversationId,
      conversationKind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      userComment,
      log: deps.log,
    }).catch((err: unknown) => {
      deps.log.error("feedback reflection failed", { error: formatUnknownError(err) });
    });
  }

  return true;
}
