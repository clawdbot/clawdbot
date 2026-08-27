import { normalizeURL } from "nostr-tools/utils";
import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { BuzzBus } from "./buzz-bus.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  formatBuzzMessageForAgent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { recordBuzzPendingHistory, snapshotBuzzPendingHistory } from "./pending-history.js";
import { getBuzzRuntime } from "./runtime.js";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";
import type { ResolvedBuzzAccount } from "./types.js";

const log = createSubsystemLogger("buzz/inbound");

export async function handleBuzzInbound(params: {
  account: ResolvedBuzzAccount;
  cfg: OpenClawConfig;
  bus: BuzzBus;
  message: BuzzInboundMessage;
  signal: AbortSignal;
  assertCurrent: () => void;
  historyMap: Map<string, HistoryEntry[]>;
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const runtime = getBuzzRuntime();
  const { account, cfg, bus, message, signal } = params;
  const channelId = parseBuzzTarget(message.channelId);
  const target = buildBuzzTarget(channelId);
  const textForAgent = formatBuzzMessageForAgent(message);
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg,
    channel: "buzz",
    accountId: account.accountId,
    peer: { kind: "group", id: target },
  });
  const supportsTextInterpretation = message.kind !== BUZZ_DIFF_MESSAGE_KIND;
  const textMention =
    supportsTextInterpretation &&
    runtime.channel.mentions.matchesMentionPatterns(
      message.text,
      runtime.channel.mentions.buildMentionRegexes(cfg, route.agentId),
    );
  const wasMentioned = message.mentionedPubkeys.includes(bus.publicKey) || textMention;
  const shouldComputeCommandAuthorized =
    supportsTextInterpretation &&
    runtime.channel.commands.shouldComputeCommandAuthorized(message.text, cfg);
  const hasControlCommand =
    shouldComputeCommandAuthorized && runtime.channel.text.hasControlCommand(message.text, cfg);
  const groupConfig = account.config.groups?.[channelId];
  const access = await resolveStableChannelMessageIngress({
    channelId: "buzz",
    accountId: account.accountId,
    identity: { key: "buzz-pubkey", entryIdPrefix: "buzz-entry" },
    subject: { stableId: message.senderPubkey },
    conversation: {
      kind: "group",
      id: channelId,
      threadId: message.threadId,
    },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: message.id,
      inboundEventKind: "user_request",
    },
    mentionFacts: { canDetectMention: true, wasMentioned },
    groupPolicy: groupConfig?.groupPolicy ?? account.config.groupPolicy,
    groupAllowFrom: groupConfig?.groupAllowFrom ?? account.config.groupAllowFrom,
    policy: {
      activation: {
        requireMention: groupConfig?.requireMention ?? true,
        allowTextCommands: true,
      },
    },
    command: shouldComputeCommandAuthorized
      ? {
          allowTextCommands: true,
          hasControlCommand,
        }
      : undefined,
  });
  // Admission awaits policy; only the transport owner can confirm membership is still current.
  params.assertCurrent();
  const historyKey = JSON.stringify([channelId, message.threadId ?? null]);
  const historyLimit = account.config.historyLimit ?? 0;
  if (access.ingress.admission !== "dispatch") {
    if (access.ingress.reasonCode === "activation_skipped") {
      await recordBuzzPendingHistory({
        historyMap: params.historyMap,
        key: historyKey,
        limit: historyLimit,
        message,
        text: textForAgent,
        shouldRecord: () =>
          !signal.aborted && bus.directory.isMember(channelId, message.senderPubkey),
      });
    }
    return;
  }

  const history = snapshotBuzzPendingHistory({
    historyMap: params.historyMap,
    key: historyKey,
    limit: historyLimit,
    channelId,
    directory: bus.directory,
    currentMessage: textForAgent,
  });

  const senderName = bus.directory.resolveSenderName(message.senderPubkey);
  const roomName = bus.directory.resolveRoomName(channelId);
  const body = buildEnvelope({
    channel: "Buzz",
    from: senderName,
    timestamp: new Date(message.createdAt * 1000),
    body: textForAgent,
  });
  const ctxPayload = (params.buildContext ?? buildChannelInboundEventContext)({
    channelIngress: access,
    channel: "buzz",
    accountId: route.accountId ?? account.accountId,
    messageId: message.id,
    messageIdFull: message.id,
    timestamp: message.createdAt * 1000,
    from: target,
    sender: { id: message.senderPubkey, name: senderName },
    conversation: {
      kind: "group",
      id: channelId,
      label: roomName,
      threadId: message.threadId,
      nativeChannelId: channelId,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: target,
      originatingTo: target,
      replyToId: message.id,
      messageThreadId: message.threadId,
      threadParentId: message.threadId ? channelId : undefined,
    },
    message: {
      body,
      bodyForAgent: history.bodyForAgent,
      rawBody: message.text,
      commandBody: supportsTextInterpretation ? message.text : "",
    },
    access: {
      commands: { authorized: access.commandAccess.authorized },
      mentions: { canDetectMention: true, wasMentioned },
    },
    extra: {
      GroupSubject: roomName,
      BuzzEventKind: message.kind,
    },
  });
  const replyTarget = {
    channelId,
    threadId: message.threadId,
    replyToId: message.threadId ?? message.id,
  };

  const result = await runtime.channel.inbound.dispatch({
    cfg,
    channel: "buzz",
    accountId: account.accountId,
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      sessionKey: route.sessionKey,
    },
    ctxPayload,
    botLoopProtection: bus.directory.isBotMember(channelId, message.senderPubkey)
      ? {
          // Reciprocal accounts share the relay/room pair budget. Threads and
          // sender timestamps must not let a bot reset or evade that budget.
          scopeId: `buzz:${normalizeURL(account.relayUrl)}`,
          conversationId: channelId,
          senderId: message.senderPubkey,
          receiverId: bus.publicKey,
          eventId: message.id,
          defaultsConfig: cfg.channels?.defaults?.botLoopProtection,
          defaultEnabled: true,
        }
      : undefined,
    log: (event) => {
      if (event.reason === "bot-loop-protection") {
        log.warn(`[${account.accountId}] Buzz bot-pair loop suppressed in ${channelId}`);
      }
    },
    delivery: {
      deliver: async (payload) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        await bus.sendText({ ...replyTarget, text });
      },
      onError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
    replyOptions: {
      abortSignal: signal,
    },
    replyPipeline: {
      typing: {
        start: async () => {
          await bus.sendTyping(replyTarget);
        },
        keepaliveIntervalMs: 3_000,
        onStartError: (error: unknown) => {
          log.error(`[${account.accountId}] Buzz typing failed for ${channelId}: ${String(error)}`);
        },
      },
    },
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`Buzz session record failed: ${String(error)}`);
      },
    },
  });
  if (result.dispatched) {
    history.consume();
  }
}
