import { normalizeURL } from "nostr-tools/utils";
import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/allow-from";
import {
  buildChannelInboundEventContext,
  logInboundDrop,
  resolveChannelInboundRouteEnvelope,
  resolveInboundSupplementalSenderAllowed,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { BuzzBus } from "./buzz-bus.js";
import type { BuzzConfigInput } from "./config-schema.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_HEX_ID_PATTERN,
  formatBuzzMessageForAgent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { recordBuzzPendingHistory, snapshotBuzzPendingHistory } from "./pending-history.js";
import { getBuzzRuntime } from "./runtime.js";
import { buildBuzzTarget, parseBuzzTarget } from "./target.js";
import type { ResolvedBuzzAccount } from "./types.js";

const log = createSubsystemLogger("buzz/inbound");

type BuzzReplyQuote = { id: string; body: string; sender?: string; senderAllowed: boolean };
type BuzzRoomPolicy = Pick<ResolvedBuzzAccount["config"], "groupPolicy" | "groupAllowFrom">;

/**
 * Resolve the message a reply points at, so the agent sees what is being
 * answered instead of a dangling "look at this".
 *
 * Fail-soft by design: a missing or unreachable parent degrades the turn to a
 * quote-less prompt rather than dropping the message. The caller re-asserts
 * liveness after the await, so cancellation still surfaces there.
 */
async function resolveBuzzReplyQuote(params: {
  bus: BuzzBus;
  message: BuzzInboundMessage;
  signal: AbortSignal;
  channelId: string;
  policy: BuzzRoomPolicy;
}): Promise<BuzzReplyQuote | undefined> {
  const { bus, message, signal } = params;
  const replyToId = message.replyToId;
  // The marker is attacker-controlled free text: never let it reach a relay
  // filter unless it is shaped like an event id.
  if (!replyToId || replyToId === message.id || !BUZZ_HEX_ID_PATTERN.test(replyToId)) {
    return undefined;
  }
  let parent: BuzzInboundMessage | null;
  try {
    parent = await bus.fetchMessageById({ eventId: replyToId, signal });
  } catch (error) {
    log.debug?.(
      `Buzz reply target ${replyToId} unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
  if (!parent || !isSameBuzzRoom(parent.channelId, params.channelId)) {
    // A reply tag can name an event in another room; never widen room scope.
    return undefined;
  }
  const quotedIsBot = parent.senderPubkey === bus.publicKey;
  // Same rule as pending history: only current room members contribute
  // model-visible context. The bot's own messages always qualify.
  if (!quotedIsBot && !bus.directory.isMember(params.channelId, parent.senderPubkey)) {
    return undefined;
  }
  const body = formatBuzzMessageForAgent(parent);
  if (!body) {
    return undefined;
  }
  return {
    id: parent.id,
    body,
    sender: bus.directory.resolveSenderName(parent.senderPubkey),
    senderAllowed: resolveBuzzQuoteSenderAllowed({
      quotedPubkey: parent.senderPubkey,
      botPublicKey: bus.publicKey,
      senderPubkey: message.senderPubkey,
      policy: params.policy,
    }),
  };
}

/** Compare an untrusted `h` tag against the room this turn belongs to, in normalized form. */
function isSameBuzzRoom(rawChannelId: string, channelId: string): boolean {
  try {
    return parseBuzzTarget(rawChannelId) === channelId;
  } catch {
    return false;
  }
}

/**
 * Whether the quoted author passes the room allowlist, for `contextVisibility`.
 * The bot's own words and the sender's own earlier words are never a leak
 * vector: the bot said it, or the sender was just admitted to say it.
 */
function resolveBuzzQuoteSenderAllowed(params: {
  quotedPubkey: string;
  botPublicKey: string;
  senderPubkey: string;
  policy: BuzzRoomPolicy;
}): boolean {
  if (params.quotedPubkey === params.botPublicKey || params.quotedPubkey === params.senderPubkey) {
    return true;
  }
  return resolveInboundSupplementalSenderAllowed({
    isGroup: true,
    groupPolicy: params.policy.groupPolicy,
    allowFrom: params.policy.groupAllowFrom ?? [],
    isSenderAllowed: (allowFrom) =>
      isNormalizedSenderAllowed({ senderId: params.quotedPubkey, allowFrom: [...allowFrom] }),
  });
}

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
      // SAFETY: Buzz's manifest schema validates this plugin-owned channel section before startup.
      const buzzConfig = cfg.channels?.buzz as BuzzConfigInput | undefined;
      const groupsPath = buzzConfig?.accounts?.[account.accountId]
        ? `channels.buzz.accounts[${JSON.stringify(account.accountId)}].groups`
        : "channels.buzz.groups";
      logInboundDrop({
        log: log.info,
        channel: "buzz",
        reason: "no mention",
        target: channelId,
        onceKey: JSON.stringify([account.accountId, channelId]),
        hint: `Mention patterns can be derived from the agent identity name. Set ${groupsPath}[${JSON.stringify(channelId)}].requireMention=false to process messages without a mention.`,
      });
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
  const replyQuote = await resolveBuzzReplyQuote({
    bus,
    message,
    signal,
    channelId,
    policy: {
      groupPolicy: groupConfig?.groupPolicy ?? account.config.groupPolicy,
      groupAllowFrom: groupConfig?.groupAllowFrom ?? account.config.groupAllowFrom,
    },
  });
  // The lookup yielded to the relay: membership may have changed underneath it,
  // and a shutdown mid-lookup must not commit the dedupe claim.
  params.assertCurrent();
  const contextVisibility = resolveChannelContextVisibilityMode({
    cfg,
    channel: "buzz",
    accountId: account.accountId,
  });
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
      // What the human replied to, matching telegram: the prompt renders this
      // alongside the quote's sender and body, and delivery uses `replyTarget`
      // below rather than this field.
      replyToId: replyQuote?.id ?? message.id,
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
    supplemental: replyQuote ? { quote: replyQuote } : undefined,
    contextVisibility,
    extra: {
      GroupSubject: roomName,
      BuzzEventKind: message.kind,
    },
  });
  const replyTarget = {
    channelId,
    threadId: account.config.replyToMode === "off" ? undefined : message.threadId,
    replyToId: account.config.replyToMode === "off" ? undefined : (message.threadId ?? message.id),
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
