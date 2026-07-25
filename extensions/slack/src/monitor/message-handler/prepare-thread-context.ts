// Slack plugin module implements prepare thread context behavior.
import {
  formatInboundEnvelope,
  resolveInboundSupplementalSenderAllowed,
} from "openclaw/plugin-sdk/channel-inbound";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ContextVisibilityMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackAllowListMatch } from "../allow-list.js";
import { readSessionUpdatedAt, resolveChannelResetConfig } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import type { SlackMediaResult } from "../media-types.js";
import { resolveSlackThreadHistory, type SlackThreadStarter } from "../thread.js";
import {
  applySlackThreadHistoryFilterPolicy,
  ensureSlackThreadHistoryHasBotRoot,
  formatSlackBotStarterThreadLabel,
  formatSlackThreadLabelSnippet,
  isSlackThreadAuthorCurrentBot,
  resolveSlackThreadHistoryFilterPolicy,
  shouldIncludeBotThreadStarterContext,
} from "./prepare-thread-context-root.js";
import { resolveSlackTimestampMs } from "./timestamp.js";

const loadSlackMediaModule = createLazyRuntimeModule(() => import("../media.js"));

type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  shouldSeedInitialThreadContext: boolean;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

const SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY = 4;

type SlackSessionResetFreshness = {
  state: "missing" | "fresh" | "stale";
};

type SlackSessionFreshnessRuntime = {
  session?: {
    resolveEntryResetFreshness?: (params: {
      storePath?: string;
      sessionKey: string;
      sessionCfg?: OpenClawConfig["session"];
      resetType: "thread";
      resetOverride?: ReturnType<typeof resolveChannelResetConfig>;
    }) => SlackSessionResetFreshness;
  };
};

function resolveSlackThreadSessionFreshness(params: {
  ctx: SlackMonitorContext;
  storePath: string;
  sessionKey: string;
}): SlackSessionResetFreshness | undefined {
  // Gateway startup supplies the full channel runtime, but the public surface
  // intentionally keeps non-context helpers untyped for external plugins.
  const runtime = params.ctx.channelRuntime as SlackSessionFreshnessRuntime | undefined;
  return runtime?.session?.resolveEntryResetFreshness?.({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    sessionCfg: params.ctx.cfg.session,
    resetType: "thread",
    resetOverride: resolveChannelResetConfig({
      sessionCfg: params.ctx.cfg.session,
      channel: "slack",
    }),
  });
}

function isSlackThreadContextSenderAllowed(params: {
  allowFromLower: string[];
  allowNameMatching: boolean;
  userId?: string;
  userName?: string;
  botId?: string;
}): boolean {
  return resolveInboundSupplementalSenderAllowed({
    isGroup: true,
    groupPolicy: params.allowFromLower.length === 0 ? "open" : "allowlist",
    allowFrom: params.allowFromLower,
    isSenderAllowed: (allowFrom) => {
      if (params.botId) {
        return true;
      }
      if (!params.userId) {
        return false;
      }
      return resolveSlackAllowListMatch({
        allowList: allowFrom,
        id: params.userId,
        name: params.userName,
        allowNameMatching: params.allowNameMatching,
      }).allowed;
    },
  });
}

async function resolveSlackThreadUserMap(params: {
  ctx: SlackMonitorContext;
  messages: SlackThreadStarter[];
  eventScope?: SlackEventScope;
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
      const user = await params.ctx.resolveUserName(id, params.eventScope);
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
  forceInitialHistory?: boolean;
  allowFromLower: string[];
  allowNameMatching: boolean;
  contextVisibilityMode: ContextVisibilityMode;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
  eventScope?: SlackEventScope;
}): Promise<SlackThreadContextData> {
  const botIdentity = {
    botUserId: params.ctx.botUserId,
    botId: params.ctx.botId,
  };
  const isCurrentBotAuthor = (author: { userId?: string; botId?: string }): boolean =>
    isSlackThreadAuthorCurrentBot({ identity: botIdentity, author });

  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;
  const threadSessionFreshness =
    params.isThreadReply && params.threadTs
      ? resolveSlackThreadSessionFreshness({
          ctx: params.ctx,
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const threadSessionPreviousTimestamp =
    params.isThreadReply && params.threadTs && !threadSessionFreshness
      ? readSessionUpdatedAt({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const shouldSeedInitialThreadContext = Boolean(
    params.isThreadReply &&
    params.threadTs &&
    (threadSessionFreshness
      ? threadSessionFreshness.state !== "fresh"
      : threadSessionPreviousTimestamp === undefined),
  );
  const shouldLoadInitialThreadHistory =
    shouldSeedInitialThreadContext || params.forceInitialHistory === true;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      shouldSeedInitialThreadContext,
      threadLabel,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  const starterSenderName =
    params.allowNameMatching && params.allowFromLower.length > 0 && starter?.userId
      ? (await params.ctx.resolveUserName(starter.userId, params.eventScope))?.name
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
    const snippet = formatSlackThreadLabelSnippet(starter.text);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    // Root media seeds a new thread session once. Rehydrating it later makes
    // old files look like current-turn uploads and repeats media processing.
    if (
      shouldSeedInitialThreadContext &&
      !params.effectiveDirectMedia &&
      starter.files &&
      starter.files.length > 0
    ) {
      const { resolveSlackMedia } = await loadSlackMediaModule();
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        client: params.eventScope?.client ?? params.ctx.app.client,
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

  const includeBotStarterAsRootContext = shouldIncludeBotThreadStarterContext({
    starterIsCurrentBot,
    isNewThreadSession: shouldSeedInitialThreadContext,
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

  if (threadInitialHistoryLimit > 0 && shouldLoadInitialThreadHistory) {
    const currentBotRootTs = starter?.ts ?? params.threadTs;
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.eventScope?.client ?? params.ctx.app.client,
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
              eventScope: params.eventScope,
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
            timestamp: resolveSlackTimestampMs(historyMsg.ts),
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
    shouldSeedInitialThreadContext,
    threadLabel,
    threadStarterMedia,
  };
}
