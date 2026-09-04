// Mattermost plugin module normalizes accepted posts into inbound turns.
import {
  formatInboundEnvelope,
  implicitMentionKindWhen,
  resolveInboundSessionEnvelopeContext,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  resolveChannelGroups,
  resolveChannelGroupsConfigPath,
} from "openclaw/plugin-sdk/channel-policy";
import {
  resolveChannelContextVisibilityMode,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeOptionalString,
  normalizeTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeMattermostAllowEntry } from "./ingress-identity.js";
import { resolveMattermostInboundMentionDecision } from "./monitor-activation.js";
import {
  formatMattermostDirectMessageDropLog,
  resolveMattermostMonitorInboundAccess,
} from "./monitor-auth.js";
import { resolveMattermostPendingHistoryKey } from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import {
  formatInboundFromLabel,
  matchesMattermostBotMention,
  normalizeMention,
  shouldDropEmptyMattermostBody,
} from "./monitor-helpers.js";
import type { MattermostIngressLifecycle, MattermostIngressPost } from "./monitor-ingress.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import {
  buildMattermostInboundMediaPayload,
  formatMattermostInboundMediaText,
  formatMattermostPendingMediaText,
} from "./monitor-resources.js";
import { dispatchMattermostInboundTurn } from "./monitor-turn.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import {
  createChannelHistoryWindow,
  DEFAULT_GROUP_HISTORY_LIMIT,
  logInboundDrop,
  type HistoryEntry,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { hasMattermostThreadParticipationWithPersistence } from "./thread-participation.js";

export function createMattermostPostHandler(monitor: MattermostMonitorContext) {
  const { account, botUserId, botUsername, cfg, core, groupPolicy, pairing, resources } = monitor;
  const groupsConfigPath = resolveChannelGroupsConfigPath({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    groups: resolveChannelGroups(cfg, "mattermost", account.accountId),
  });
  const { resolveMattermostMedia, resolveUserInfo } = resources;
  const channelHistories = new Map<string, HistoryEntry[]>();
  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );

  return async (
    post: MattermostIngressPost,
    payload: MattermostEventPayload,
    turnAdoptionLifecycle?: MattermostIngressLifecycle,
    messageIds?: string[],
  ) => {
    const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (!channelId) {
      monitor.logVerboseMessage("mattermost: drop post (missing channel id)");
      return;
    }
    if (!post.id) {
      monitor.logVerboseMessage("mattermost: drop post (missing message id)");
      return;
    }
    const allMessageIds = messageIds?.length ? messageIds : [post.id];
    const senderId = post.user_id;
    if (senderId === botUserId) {
      monitor.logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
      return;
    }
    if (normalizeOptionalString(post.type) !== undefined) {
      monitor.logVerboseMessage(
        `mattermost: drop post (system post type=${post.type ?? "unknown"})`,
      );
      return;
    }

    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId,
      senderId,
      postId: post.id,
      threadRootId: normalizeOptionalString(post.root_id),
      channelTypeFallback: payload.data?.channel_type,
      teamId: payload.data?.team_id,
      channelName: payload.data?.channel_name,
      channelDisplay: payload.data?.channel_display_name,
      dropLabel: "post",
    });
    if (!eventPlan) {
      return;
    }
    const { channelDisplay, kind, roomLabel, route, thread } = eventPlan;
    const senderName =
      normalizeOptionalString(payload.data?.sender_name) ??
      normalizeOptionalString((await resolveUserInfo(senderId))?.username) ??
      senderId;
    const rawPostText = typeof post.message === "string" ? post.message : "";
    const rawText = normalizeOptionalString(rawPostText) ?? "";
    const { effectiveReplyToId, sessionKey } = thread;
    const { envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      cfg,
      agentId: route.agentId,
      sessionKey,
    });
    const historyKey = resolveMattermostPendingHistoryKey({ kind, sessionKey });
    const fileIds = uniqueStrings(normalizeTrimmedStringList(post.file_ids ?? []));
    const nativeMedia = fileIds.map(() => ({}));
    const pendingBody = formatMattermostPendingMediaText({ body: rawText, media: nativeMedia });
    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      createChannelHistoryWindow({ historyMap: channelHistories }).record({
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: senderName,
                body: trimmed,
                timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
                messageId: post.id,
              }
            : null,
      });
    };
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const isControlCommand =
      allowTextCommands && core.channel.commands.isControlCommandMessage(rawText, cfg);
    const accessDecision = await resolveMattermostMonitorInboundAccess({
      account,
      cfg,
      senderId,
      senderName,
      channelId,
      kind,
      groupPolicy,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands,
      hasControlCommand: isControlCommand,
      eventKind: "message",
      mayPair: true,
    });
    const commandAuthorized = accessDecision.commandAccess.authorized;

    if (accessDecision.ingress.decision !== "allow") {
      if (kind === "direct") {
        if (accessDecision.ingress.reasonCode === "dm_policy_disabled") {
          monitor.logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
          return;
        }
        if (accessDecision.ingress.decision === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName },
          });
          monitor.logVerboseMessage(
            `mattermost: pairing request sender=${senderId} created=${created}`,
          );
          if (created) {
            try {
              await sendMessageMattermost(
                `channel:${channelId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "mattermost",
                  idLine: `Your Mattermost user id: ${senderId}`,
                  code,
                }),
                { cfg, accountId: account.accountId },
              );
              monitor.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              monitor.logVerboseMessage(
                `mattermost: pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
          return;
        }
        monitor.logVerboseMessage(
          formatMattermostDirectMessageDropLog({
            senderId,
            dmPolicy: account.config.dmPolicy ?? "pairing",
            reasonCode: accessDecision.senderAccess.reasonCode,
          }),
        );
        return;
      }
      if (accessDecision.ingress.reasonCode === "group_policy_disabled") {
        monitor.logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
        return;
      }
      if (accessDecision.ingress.reasonCode === "group_policy_empty_allowlist") {
        monitor.logVerboseMessage("mattermost: drop group message (no group allowlist)");
        return;
      }
      if (accessDecision.ingress.reasonCode === "group_policy_not_allowlisted") {
        // Trigger allowlists do not hide history unless context visibility opts in.
        // Denied senders must still return before commands, sessions, or replies.
        if (
          shouldIncludeSupplementalContext({
            mode: resolveChannelContextVisibilityMode({
              cfg,
              channel: "mattermost",
              accountId: account.accountId,
            }),
            kind: "history",
            senderAllowed: false,
          })
        ) {
          recordPendingHistory();
        }
        monitor.logVerboseMessage(
          `mattermost: drop group sender=${senderId} (not in groupAllowFrom)`,
        );
        return;
      }
      monitor.logVerboseMessage(
        `mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.senderAccess.reasonCode})`,
      );
      return;
    }

    if (kind !== "direct" && accessDecision.commandAccess.shouldBlockControlCommand) {
      logInboundDrop({
        log: monitor.logVerboseMessage,
        channel: "mattermost",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      kind !== "direct" &&
      (matchesMattermostBotMention(rawText, botUsername) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled
      ? stripOncharPrefix(rawText, oncharPrefixes)
      : { triggered: false, stripped: rawText };
    const oncharTriggered = oncharResult.triggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    // Threads the bot already replied in auto-engage: follow-ups resume without
    // a re-mention even under requireMention. Keyed by the thread root id.
    const threadAlreadyEngaged =
      kind !== "direct" && effectiveReplyToId
        ? await hasMattermostThreadParticipationWithPersistence({
            accountId: account.accountId,
            channelId,
            threadRootId: effectiveReplyToId,
          })
        : false;
    const shouldRequireMention =
      kind !== "direct" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "mattermost",
        accountId: account.accountId,
        groupId: channelId,
        requireMentionOverride: account.requireMention,
      });
    const mentionDecision = resolveMattermostInboundMentionDecision({
      cfg,
      accountId: account.accountId,
      kind,
      requireMention: shouldRequireMention || oncharEnabled,
      canDetectMention: canDetectMention || oncharEnabled,
      wasMentioned: wasMentioned || oncharTriggered,
      implicitMentionKinds: implicitMentionKindWhen("bot_thread_participant", threadAlreadyEngaged),
      allowTextCommands,
      hasControlCommand: isControlCommand,
      commandAuthorized,
    });
    const { shouldBypassMention } = mentionDecision;

    if (
      mentionDecision.shouldSkip &&
      oncharEnabled &&
      !oncharTriggered &&
      !wasMentioned &&
      !shouldBypassMention
    ) {
      monitor.logVerboseMessage(
        `mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`,
      );
      recordPendingHistory();
      return;
    }
    if (mentionDecision.shouldSkip) {
      logInboundDrop({
        log: monitor.runtime.log,
        channel: "mattermost",
        reason: "no mention",
        target: channelId,
        onceKey: JSON.stringify([account.accountId, channelId]),
        hint: `Mention patterns can be derived from the agent identity name. Set ${groupsConfigPath}[${JSON.stringify(channelId)}].requireMention=false to process messages without a mention. Preserve existing groups entries; when adding the first groups map, include "*": {} to keep other chats admitted.`,
      });
      recordPendingHistory();
      return;
    }

    const mediaList = await resolveMattermostMedia(fileIds);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = formatMattermostInboundMediaText({
      body: bodySource,
      nativeMedia,
      materializedMedia: mediaList,
    });
    const bodyText = normalizeMention(baseText, botUsername);
    if (
      mediaList.length === 0 &&
      shouldDropEmptyMattermostBody({ bodyText, rawText: rawPostText, botUsername })
    ) {
      monitor.logVerboseMessage(
        `mattermost: drop message (empty body after normalization channel=${channelId} sender=${senderId} wasMentioned=${wasMentioned})`,
      );
      return;
    }
    // Mention-only turns need non-empty agent text; the shared reply runner rejects empty
    // bodies before model invocation. The guard above ensures this fallback is a bot mention.
    const bodyForAgent = bodyText || rawText.trim();
    core.channel.activity.record({
      channel: "mattermost",
      accountId: account.accountId,
      direction: "inbound",
    });

    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: channelDisplay || roomLabel,
      groupId: channelId,
      groupFallback: roomLabel || "Channel",
      directLabel: senderName,
      directId: senderId,
    });
    const textWithId = `${bodyText}\n[mattermost message id: ${post.id} channel: ${channelId}]`;
    const body = formatInboundEnvelope({
      channel: "Mattermost",
      from: fromLabel,
      timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
      body: textWithId,
      chatType: kind,
      sender: { name: senderName, id: senderId },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    if (historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: channelHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatInboundEnvelope({
            channel: "Mattermost",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""
            }`,
            chatType: kind,
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }),
      });
    }

    const commandBody = rawText.trim();
    const inboundHistory =
      historyKey && historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: channelHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;
    const ctxPayload = eventPlan.finalizeContext({
      Body: combinedBody,
      BodyForAgent: bodyForAgent,
      InboundHistory: inboundHistory,
      RawBody: commandBody,
      CommandBody: commandBody,
      BodyForCommands: commandBody,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
      SenderName: senderName,
      MessageSid: post.id,
      MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
      MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
      MessageSidLast:
        allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
      Timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
      WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      // Tag typed text-slash control commands (e.g. ` /new`, ` /reset` sent via the regular
      // post path rather than Mattermost's native slash UI) so the explicit-command turn
      // exception in source-reply-delivery-mode.ts surfaces their acknowledgements under
      // message_tool_only delivery modes (e.g. Codex harness DMs). Mirrors iMessage #82642.
      CommandSource: commandAuthorized && isControlCommand ? ("text" as const) : undefined,
      ...(await buildMattermostInboundMediaPayload(mediaList)),
    });
    const pinnedMainDmOwner =
      kind === "direct"
        ? resolvePinnedMainDmOwnerFromAllowlist({
            dmScope: cfg.session?.dmScope,
            allowFrom: account.config.allowFrom,
            normalizeEntry: normalizeMattermostAllowEntry,
          })
        : null;
    const previewLine = truncateUtf16Safe(bodyText, 200).replace(/\n/g, "\\n");
    monitor.logVerboseMessage(
      `mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    await dispatchMattermostInboundTurn(monitor, {
      post,
      rawText,
      ctxPayload,
      eventPlan,
      historyKey,
      historyLimit,
      channelHistories,
      pinnedMainDmOwner,
      turnAdoptionLifecycle,
    });
  };
}
