import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveIdentityName,
} from "../../../agents/identity.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../../auto-reply/reply/response-prefix-template.js";
import { dispatchReplyFromConfig } from "../../../auto-reply/reply/dispatch-from-config.js";
import { clearHistoryEntries } from "../../../auto-reply/reply/history.js";
import { createReplyDispatcherWithTyping } from "../../../auto-reply/reply/reply-dispatcher.js";
import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../globals.js";
import { removeSlackReaction } from "../../actions.js";
import { resolveSlackThreadTargets } from "../../threading.js";

import { createSlackReplyDeliveryPlan, deliverReplies } from "../replies.js";

import type { PreparedSlackMessage } from "./types.js";

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "slack",
        to: `user:${message.user}`,
        accountId: route.accountId,
      },
      ctx: prepared.ctxPayload,
    });
  }

  const { statusThreadTs } = resolveSlackThreadTargets({
    message,
    replyToMode: ctx.replyToMode,
  });

  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: ctx.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
  });

  const onReplyStart = async () => {
    didSetStatus = true;
    await ctx.setSlackThreadStatus({
      channelId: message.channel,
      threadTs: statusThreadTs,
      status: "is typing...",
    });
  };

  // Create mutable context for response prefix template interpolation
  let prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(cfg, route.agentId),
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload) => {
      const replyThreadTs = replyPlan.nextThreadTs();
      await deliverReplies({
        replies: [payload],
        target: prepared.replyTarget,
        token: ctx.botToken,
        accountId: account.accountId,
        runtime,
        textLimit: ctx.textLimit,
        replyThreadTs,
      });
      replyPlan.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      if (didSetStatus) {
        void ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "",
        });
      }
    },
    onReplyStart,
  });

  const { queuedFinal, counts } = await dispatchReplyFromConfig({
    ctx: prepared.ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: prepared.channelConfig?.skills,
      hasRepliedRef,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      onModelSelected: (ctx) => {
        // Mutate the object directly instead of reassigning to ensure the closure sees updates
        prefixContext.provider = ctx.provider;
        prefixContext.model = extractShortModelName(ctx.model);
        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
      },
    },
  });
  markDispatchIdle();

  if (didSetStatus) {
    await ctx.setSlackThreadStatus({
      channelId: message.channel,
      threadTs: statusThreadTs,
      status: "",
    });
  }

  if (!queuedFinal) {
    if (prepared.isRoomish && ctx.historyLimit > 0) {
      clearHistoryEntries({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
      });
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  if (ctx.removeAckAfterReply && prepared.ackReactionPromise && prepared.ackReactionMessageTs) {
    const messageTs = prepared.ackReactionMessageTs;
    const ackValue = prepared.ackReactionValue;
    void prepared.ackReactionPromise.then((didAck) => {
      if (!didAck) return;
      removeSlackReaction(message.channel, messageTs, ackValue, {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
        logVerbose(
          `slack: failed to remove ack reaction from ${message.channel}/${message.ts}: ${String(err)}`,
        );
      });
    });
  }

  if (prepared.isRoomish && ctx.historyLimit > 0) {
    clearHistoryEntries({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
    });
  }
}
