import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { BuzzBus } from "./buzz-bus.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  formatBuzzMessageForAgent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { getBuzzRuntime } from "./runtime.js";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";
import type { ResolvedBuzzAccount } from "./types.js";

const log = createSubsystemLogger("buzz/inbound");

function senderLabel(pubkey: string): string {
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-6)}`;
}

export async function handleBuzzInbound(params: {
  account: ResolvedBuzzAccount;
  cfg: OpenClawConfig;
  bus: BuzzBus;
  message: BuzzInboundMessage;
}) {
  const runtime = getBuzzRuntime();
  const { account, cfg, bus, message } = params;
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
    mentionFacts: { canDetectMention: true, wasMentioned },
    groupPolicy: account.config.groupPolicy,
    groupAllowFrom: account.config.groupAllowFrom,
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
  if (access.ingress.admission !== "dispatch") {
    return;
  }

  const senderName = senderLabel(message.senderPubkey);
  const body = buildEnvelope({
    channel: "Buzz",
    from: senderName,
    timestamp: new Date(message.createdAt * 1000),
    body: textForAgent,
  });
  const ctxPayload = buildChannelInboundEventContext({
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
      label: channelId,
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
      bodyForAgent: textForAgent,
      rawBody: message.text,
      commandBody: supportsTextInterpretation ? message.text : "",
    },
    access: {
      commands: { authorized: access.commandAccess.authorized },
      mentions: { canDetectMention: true, wasMentioned },
    },
    extra: {
      GroupChannel: channelId,
      GroupSubject: channelId,
      BuzzEventKind: message.kind,
    },
  });

  await runtime.channel.inbound.dispatch({
    cfg,
    channel: "buzz",
    accountId: account.accountId,
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      sessionKey: route.sessionKey,
    },
    ctxPayload,
    delivery: {
      deliver: async (payload) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        await bus.sendText({
          channelId,
          text,
          threadId: message.threadId,
          replyToId: message.id,
        });
      },
      onError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
    replyPipeline: {
      typing: {
        start: async () => {
          await bus.sendTyping({
            channelId,
            threadId: message.threadId,
            replyToId: message.id,
          });
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
}
