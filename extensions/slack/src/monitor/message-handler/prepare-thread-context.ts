import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ContextVisibilityMode } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackAllowListMatch } from "../allow-list.js";
import { readSessionUpdatedAt } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMediaResult } from "../media-types.js";
import { resolveSlackThreadHistory, type SlackThreadStarter } from "../thread.js";
import {
  applySlackThreadHistoryFilterPolicy,
  ensureSlackThreadHistoryHasBotRoot,
  formatSlackBotStarterThreadLabel,
  isSlackThreadAuthorCurrentBot,
  resolveSlackThreadHistoryFilterPolicy,
  shouldIncludeBotThreadStarterContext,
} from "./prepare-thread-context-root.js";

type SlackMediaModule = typeof import("../media.js");
let slackMediaModulePromise: Promise<SlackMediaModule> | undefined;

function loadSlackMediaModule(): Promise<SlackMediaModule> {
  slackMediaModulePromise ??= import("../media.js");
  return slackMediaModulePromise;
}

type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  threadSessionPreviousTimestamp: number | undefined;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

const SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY = 4;

function isSlackThreadContextSenderAllowed(params: {
  allowFromLower: string[];
  allowNameMatching: boolean;
  userId?: string;
  userName?: string;
  botId?: string;
}): boolean {
  if (params.allowFromLower.length === 0 || params.botId) {
    return true;
  }
  if (!params.userId) {
    return false;
  }
  return resolveSlackAllowListMatch({
    allowList: params.allowFromLower,
    id: params.userId,
    name: params.userName,
    allowNameMatching: params.allowNameMatching,
  }).allowed;
}

async function resolveSlackThreadUserMap(params: {
  ctx: SlackMonitorContext;
  messages: SlackThreadStarter[];
}): Promise<Map<string, { name?: string }>> {
  const uniqueUserIds: string[] = [];
  const seen = new Set<string>();
  for (const item of params.messages) {
    if (!item.userId || seen.has(item.userId)) {
      continue;
    }
    seen.add(item.userId);
    uniqueUserIds.push(item.userId);
  }
  const userMap = new Map<string, { name?: string }>();
  if (uniqueUserIds.length === 0) {
    return userMap;
  }
  const { results } = await runTasksWithConcurrency({
    tasks: uniqueUserIds.map((id) => async () => {
      const user = await params.ctx.resolveUserName(id);
      return user ? { id, user } : null;
    }),
    limit: SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY,
  });
  for (const result of results) {
    if (result) {
      userMap.set(result.id, result.user);
    }
  }
  return userMap;
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  allowFromLower: string[];
  allowNameMatching: boolean;
  contextVisibilityMode: ContextVisibilityMode;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
  const botIdentity = {
    botUserId: params.ctx.botUserId,
    botId: params.ctx.botId,
  };
  const isCurrentBotAuthor = (author: { userId?: string; botId?: string }): boolean =>
    isSlackThreadAuthorCurrentBot({ identity: botIdentity, author });

  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  const starterSenderName =
    params.allowNameMatching && params.allowFromLower.length > 0 && starter?.userId
      ? (await params.ctx.resolveUserName(starter.userId))?.name
      : undefined;
  const starterIsCurrentBot = Boolean(
    starter &&
    isCurrentBotAuthor({
      userId: starter.userId,
      botId: starter.botId,
    }),
  );
  const starterAllowed =
    !starter ||
    (!starterIsCurrentBot &&
      isSlackThreadContextSenderAllowed({
        allowFromLower: params.allowFromLower,
        allowNameMatching: params.allowNameMatching,
        userId: starter.userId,
        userName: starterSenderName,
        botId: starter.botId,
      }));
  const includeStarterContext =
    !starter ||
    (!starterIsCurrentBot &&
      shouldIncludeSupplementalContext({
        mode: params.contextVisibilityMode,
        kind: "thread",
        senderAllowed: starterAllowed,
      }));

  if (starter?.text && includeStarterContext) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      const { resolveSlackMedia } = await loadSlackMediaModule();
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        client: params.ctx.app.client,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes,
      });
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }

  threadSessionPreviousTimestamp = readSessionUpdatedAt({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
  const isNewThreadSession = !threadSessionPreviousTimestamp;
  const includeBotStarterAsRootContext = shouldIncludeBotThreadStarterContext({
    starterIsCurrentBot,
    isNewThreadSession,
    hasStarterText: Boolean(starter?.text),
  });

  if (starter?.text && starterIsCurrentBot && !includeBotStarterAsRootContext) {
    logVerbose("slack: omitted current-bot thread starter from context");
  } else if (starter?.text && !includeStarterContext && !starterIsCurrentBot) {
    logVerbose(
      `slack: omitted thread starter from context (mode=${params.contextVisibilityMode}, sender_allowed=${starterAllowed ? "yes" : "no"})`,
    );
  } else if (includeBotStarterAsRootContext) {
    threadLabel = formatSlackBotStarterThreadLabel({
      roomLabel: params.roomLabel,
      starterText: starter?.text,
    });
    logVerbose("slack: retained current-bot thread starter as assistant root context");
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;

  if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
    const currentBotRootTs = starter?.ts ?? params.threadTs;
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
    });

    const threadHistoryWithBotRoot = ensureSlackThreadHistoryHasBotRoot({
      history: threadHistory,
      includeBotStarterAsRootContext,
      threadStarter: starter ? { ...starter, ts: currentBotRootTs } : null,
    });

    if (threadHistoryWithBotRoot.length > 0) {
      const historyFilterPolicy = resolveSlackThreadHistoryFilterPolicy({
        includeBotStarterAsRootContext,
        starterTs: currentBotRootTs,
      });
      const {
        kept: threadHistoryWithoutCurrentBot,
        omittedCurrentBot: omittedCurrentBotHistoryCount,
      } = applySlackThreadHistoryFilterPolicy({
        history: threadHistoryWithBotRoot,
        policy: historyFilterPolicy,
        identity: botIdentity,
      });

      const userMapForFilter =
        params.contextVisibilityMode !== "all" &&
        params.allowNameMatching &&
        params.allowFromLower.length > 0
          ? await resolveSlackThreadUserMap({
              ctx: params.ctx,
              messages: threadHistoryWithoutCurrentBot,
            })
          : new Map<string, { name?: string }>();
      const { items: filteredThreadHistory, omitted: omittedHistoryCount } =
        params.contextVisibilityMode === "all"
          ? { items: threadHistoryWithoutCurrentBot, omitted: 0 }
          : filterSupplementalContextItems({
              items: threadHistoryWithoutCurrentBot,
              mode: params.contextVisibilityMode,
              kind: "thread",
              isSenderAllowed: (historyMsg) => {
                if (
                  isCurrentBotAuthor({
                    userId: historyMsg.userId,
                    botId: historyMsg.botId,
                  })
                ) {
                  return true;
                }
                const msgUser = historyMsg.userId ? userMapForFilter.get(historyMsg.userId) : null;
                return isSlackThreadContextSenderAllowed({
                  allowFromLower: params.allowFromLower,
                  allowNameMatching: params.allowNameMatching,
                  userId: historyMsg.userId,
                  userName: msgUser?.name,
                  botId: historyMsg.botId,
                });
              },
            });
      const userMap = await resolveSlackThreadUserMap({
        ctx: params.ctx,
        messages: filteredThreadHistory,
      });
      if (omittedHistoryCount > 0 || omittedCurrentBotHistoryCount > 0) {
        logVerbose(
          `slack: omitted ${omittedHistoryCount + omittedCurrentBotHistoryCount} thread message(s) from context (mode=${params.contextVisibilityMode})`,
        );
      }

      const historyParts: string[] = [];
      for (const historyMsg of filteredThreadHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const isOtherBot = Boolean(historyMsg.botId) && historyMsg.botId !== params.ctx.botId;
        const isCurrentBot = isCurrentBotAuthor({
          userId: historyMsg.userId,
          botId: historyMsg.botId,
        });
        const isAssistantRole = isCurrentBot || isOtherBot || Boolean(historyMsg.botId);
        const role = isAssistantRole ? "assistant" : "user";
        const msgSenderName = isCurrentBot
          ? "Bot (this assistant)"
          : (msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown"));
        const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions,
          }),
        );
      }
      if (historyParts.length > 0) {
        threadHistoryBody = historyParts.join("\n\n");
        logVerbose(
          `slack: populated thread history with ${filteredThreadHistory.length} messages for new session`,
        );
      }
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  };
}
