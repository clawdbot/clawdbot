// Msteams plugin module implements message handler behavior.
import {
  formatMediaPlaceholderText,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveMSTeamsAccountConfig } from "../accounts.js";
import { formatUnknownError } from "../errors.js";
import { normalizeMSTeamsConversationId, parseMSTeamsActivityTimestamp } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import { resolveMSTeamsReplyPolicy } from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { admitMSTeamsMessage } from "./access.js";
import { prepareMSTeamsInboundContent } from "./inbound-content.js";
import { dispatchMSTeamsInboundTurn } from "./inbound-dispatch.js";
import {
  assembleMSTeamsInboundFacts,
  prepareMSTeamsDebounceEntry,
  type MSTeamsDebounceEntry,
} from "./inbound-facts.js";
import { prepareMSTeamsThreadRouting, resolveMSTeamsThreadContext } from "./thread-context.js";

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    accountId,
    runtime,
    appId,
    app,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  } = deps;
  const core = getMSTeamsRuntime();
  const logVerboseMessage = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      log.debug?.(message);
    }
  };
  const msteamsCfg = cfg.channels?.msteams
    ? resolveMSTeamsAccountConfig(cfg, accountId)
    : undefined;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "msteams",
    accountId,
  });
  const historyLimit = Math.max(
    0,
    msteamsCfg?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "msteams",
  });

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const facts = assembleMSTeamsInboundFacts({ entry: params, mediaMaxBytes });
    const {
      context,
      activity,
      rawText,
      text,
      attachments,
      advertisedMedia,
      rawBody,
      quoteInfo,
      from,
      conversation,
      attachmentTypes,
      htmlSummary,
      conversationId,
      conversationMessageId,
      conversationType,
      isChannel,
      teamId,
      conversationRef,
    } = facts;
    const historyBody = [text, formatMediaPlaceholderText(advertisedMedia)]
      .filter(Boolean)
      .join("\n");
    log.info("received message", {
      rawText: truncateUtf16Safe(rawText, 50),
      text: truncateUtf16Safe(text, 50),
      attachments: attachments.length,
      attachmentTypes,
      from: from?.id,
      conversation: conversation?.id,
    });
    if (htmlSummary) {
      log.debug?.("html attachment summary", htmlSummary);
    }

    if (!from?.id) {
      log.debug?.("skipping message without from.id");
      return;
    }

    const admission = await admitMSTeamsMessage({
      cfg,
      accountId,
      activity,
      text,
      conversationId,
      conversationRef,
      isChannel,
      conversationStore,
      log,
      logVerboseMessage,
    });
    if (!admission) {
      return;
    }
    const {
      senderId,
      senderName,
      isDirectMessage,
      channelGate,
      allowNameMatching,
      groupPolicy,
      commandAuthorized,
      effectiveGroupAllowFrom,
      allowTextCommands,
      isControlCommand,
    } = admission;

    const pollVote = extractMSTeamsPollVote(activity);
    if (pollVote) {
      try {
        const poll = await pollStore.recordVote({
          pollId: pollVote.pollId,
          voterId: senderId,
          selections: pollVote.selections,
        });
        if (!poll) {
          log.debug?.("poll vote ignored (poll not found)", {
            pollId: pollVote.pollId,
          });
        } else {
          log.info("recorded poll vote", {
            pollId: pollVote.pollId,
            voter: senderId,
            selections: pollVote.selections,
          });
        }
      } catch (err) {
        log.error("failed to record poll vote", {
          pollId: pollVote.pollId,
          error: formatUnknownError(err),
        });
      }
      return;
    }

    const threadRouting = prepareMSTeamsThreadRouting({
      cfg,
      accountId,
      context,
      isDirectMessage,
      isChannel,
      senderId,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      teamId,
      log,
    });
    const { route, deadline: preprocessingDeadline } = threadRouting;

    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    const enqueuePrimaryMessageSystemEvent = () =>
      core.system.enqueueSystemEvent(inboundLabel, {
        sessionKey: route.sessionKey,
        contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
      });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = channelGate;
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: msteamsCfg,
      teamConfig,
      channelConfig,
    });
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        implicitMentionKinds: params.implicitMentionKinds,
      },
      policy: {
        isGroup: !isDirectMessage,
        requireMention,
        allowTextCommands,
        hasControlCommand: isControlCommand,
        commandAuthorized: commandAuthorized === true,
      },
    });

    if (!isDirectMessage) {
      const mentioned = mentionDecision.effectiveWasMentioned;
      if (requireMention && mentionDecision.shouldSkip) {
        log.debug?.("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        if (historyBody) {
          enqueuePrimaryMessageSystemEvent();
          createChannelHistoryWindow({ historyMap: conversationHistories }).record({
            historyKey: conversationId,
            limit: historyLimit,
            entry: {
              sender: senderName,
              body: historyBody,
              timestamp: timestamp?.getTime(),
              messageId: activity.id ?? undefined,
            },
          });
        }
        return;
      }
    }
    const content = await prepareMSTeamsInboundContent({
      entry: params,
      rawBody,
      advertisedMedia,
      htmlSummary: htmlSummary ?? undefined,
      conversationType,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      teamAadGroupId: threadRouting.getTeamAadGroupId(),
      resolveTeamAadGroupId: threadRouting.resolveTeamAadGroupId,
      mediaMaxBytes,
      tokenProvider,
      mediaAllowHosts: msteamsCfg?.mediaAllowHosts,
      mediaAuthAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
      graphMediaFallback: msteamsCfg?.graphMediaFallback,
      deadline: preprocessingDeadline,
      log,
    });
    if (!content) {
      return;
    }
    enqueuePrimaryMessageSystemEvent();

    const thread = await resolveMSTeamsThreadContext({
      routing: threadRouting,
      context,
      tokenProvider,
      quoteInfo,
      isDirectMessage,
      isChannel,
      conversationId,
      contextVisibilityMode,
      groupPolicy,
      effectiveGroupAllowFrom,
      allowNameMatching,
      log,
    });

    await dispatchMSTeamsInboundTurn({
      cfg,
      runtime,
      appId,
      app,
      tokenProvider,
      textLimit,
      log,
      logVerboseMessage,
      facts,
      admission,
      content,
      routing: threadRouting,
      thread,
      replyStyle,
      timestamp,
      contextVisibilityMode,
      mentionWasEffective: mentionDecision.effectiveWasMentioned,
      conversationHistories,
      historyLimit,
    });
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MSTeamsDebounceEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = normalizeMSTeamsConversationId(
        entry.context.activity.conversation?.id ?? "",
      );
      const senderId =
        entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
      if (!senderId || !conversationId) {
        return null;
      }
      return `msteams:${appId}:${conversationId}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) {
        return false;
      }
      if (entry.attachments.length > 0) {
        return false;
      }
      return !core.channel.commands.isControlCommandMessage(entry.text, cfg);
    },
    onFlush: (entries, createFlush) => {
      const last = entries.at(-1);
      const { lifecycle, settle } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          if (!last) {
            return;
          }
          try {
            if (entries.length === 1) {
              await handleTeamsMessageNow({ ...last, turnAdoptionLifecycle: admissionLifecycle });
            } else {
              const combinedText = entries
                .map((entry) => entry.text)
                .filter(Boolean)
                .join("\n");
              if (combinedText.trim()) {
                const combinedRawText = entries
                  .map((entry) => entry.rawText)
                  .filter(Boolean)
                  .join("\n");
                const wasMentioned = entries.some((entry) => entry.wasMentioned);
                const implicitMentionKinds = entries.flatMap((entry) => entry.implicitMentionKinds);
                await handleTeamsMessageNow({
                  context: last.context,
                  rawText: combinedRawText,
                  text: combinedText,
                  attachments: [],
                  wasMentioned,
                  implicitMentionKinds,
                  turnAdoptionLifecycle: admissionLifecycle,
                });
              }
            }
            await settle();
          } catch (err) {
            await admissionLifecycle.onAbandoned();
            throw err;
          }
        },
      });
    },
    onError: (err) => {
      runtime.error(`msteams debounce flush failed: ${formatUnknownError(err)}`);
    },
  });

  return async function handleTeamsMessage(
    context: MSTeamsTurnContext,
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
  ) {
    const entry = await prepareMSTeamsDebounceEntry({
      context,
      accountId,
      turnAdoptionLifecycle,
    });
    await inboundDebouncer.enqueue(entry);
    if (turnAdoptionLifecycle) {
      // Keep the durable claim held across the debounce window. The merged
      // flush completes it only when the reply lane adopts (or terminally skips).
      return { kind: "deferred" } as const;
    }
    return undefined;
  };
}
