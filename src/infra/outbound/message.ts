// Outbound message entrypoint resolves channel/target, durable capability
// requirements, payload plans, gateway fallback, and optional mirroring.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChatType } from "../../channels/chat-type.js";
import { deriveDurableFinalDeliveryRequirements } from "../../channels/message/capabilities.js";
import {
  sendDurableMessageBatch,
  serializeDurableMessagePayloadOutcomes,
  type SerializedDurableMessagePayloadOutcome,
} from "../../channels/message/runtime.js";
import type { DurableMessageSendIntent } from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { PollInput } from "../../polls.js";
import { normalizePollInput } from "../../polls.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import {
  resolveOutboundDurableFinalDeliverySupport,
  type DurableFinalDeliveryRequirements,
  type OutboundDeliveryResult,
  type OutboundDeliveryQueuePolicy,
  type OutboundSendDeps,
} from "./deliver.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import {
  resolveOutboundMessageGatewayOptions,
  type OutboundMessageGatewayOptionsInput,
} from "./message-gateway-options.js";
import type { OutboundMirror } from "./mirror.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForMirror,
  type NormalizedOutboundPayload,
} from "./payloads.js";
import { buildOutboundSessionContext } from "./session-context.js";
import { assertAgentSessionOwnerPairs } from "./session-owner.js";
import { resolveOutboundTarget } from "./targets.js";

const SEND_BUFFER_MEDIA_URL = "buffer://message-send/attachment";

const loadMessageConfigRuntime = createLazyRuntimeModule(
  () => import("./message.config.runtime.js"),
);

// Keep config/runtime loading lazy so importing message helpers does not
// bootstrap plugin registries or gateway clients.
const loadMessageGatewayRuntime = createLazyRuntimeModule(
  () => import("./message.gateway.runtime.js"),
);

type MessageSendParams = {
  to: string;
  content: string;
  /** Active agent id for per-agent outbound media root scoping. */
  agentId?: string;
  /** Originating session key used for requester-scoped outbound media policy. */
  requesterSessionKey?: string;
  /** Originating account id used for requester-scoped outbound media policy. */
  requesterAccountId?: string;
  /** Originating sender id used for sender-scoped outbound media policy. */
  requesterSenderId?: string;
  /** Originating sender display name for name-keyed sender policy matching. */
  requesterSenderName?: string;
  /** Originating sender username for username-keyed sender policy matching. */
  requesterSenderUsername?: string;
  /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
  requesterSenderE164?: string;
  channel?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  buffer?: string;
  filename?: string;
  contentType?: string;
  asVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  accountId?: string;
  /** Known destination conversation kind prepared by the caller. */
  conversationType?: ChatType;
  conversationReadOrigin?: "delegated" | "direct-operator";
  replyToId?: string;
  threadId?: string | number;
  dryRun?: boolean;
  bestEffort?: boolean;
  queuePolicy?: OutboundDeliveryQueuePolicy;
  payloads?: ReplyPayload[];
  mediaAccess?: OutboundMediaAccess;
  deps?: OutboundSendDeps;
  cfg?: OpenClawConfig;
  gateway?: OutboundMessageGatewayOptionsInput;
  idempotencyKey?: string;
  /** @internal Channel-valid id reserved before a correlated conversation turn is sent. */
  preparedMessageId?: string;
  /** @internal Use the active adapter directly when already executing inside the Gateway. */
  gatewayOwnedDelivery?: boolean;
  /** @internal Stable producer id for idempotent durable queue creation. */
  deliveryIntentId?: string;
  /** @internal Serializable owner state finalized by live send or recovery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** @internal Override provider unknown-send reconciliation independently from queue durability. */
  requireUnknownSendReconciliation?: boolean;
  /** @internal Runs after queue persistence and before platform I/O. */
  onDeliveryIntent?: (intent: DurableMessageSendIntent) => void;
  /** @internal Runs on identified platform evidence before queue acknowledgement. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  mirror?: OutboundMirror;
  /** @internal Reports the effective payload only after an identified direct send. */
  onDeliveredPayload?: (payload: NormalizedOutboundPayload) => void;
  abortSignal?: AbortSignal;
  silent?: boolean;
  parseMode?: "HTML";
};

export type MessageSendResult = {
  channel: string;
  to: string;
  via: "direct" | "gateway";
  mediaUrl: string | null;
  mediaUrls?: string[];
  result?: OutboundDeliveryResult | { messageId: string };
  deliveryStatus?: "sent" | "suppressed" | "partial_failed" | "failed";
  /** Formatted send error when deliveryStatus is "failed" or "partial_failed". */
  error?: string;
  sentBeforeError?: boolean;
  payloadOutcomes?: SerializedDurableMessagePayloadOutcome[];
  dryRun?: boolean;
};

type MessagePollParams = {
  to: string;
  question: string;
  options: string[];
  maxSelections?: number;
  durationSeconds?: number;
  durationHours?: number;
  channel?: string;
  accountId?: string;
  threadId?: string;
  silent?: boolean;
  isAnonymous?: boolean;
  dryRun?: boolean;
  cfg?: OpenClawConfig;
  gateway?: OutboundMessageGatewayOptionsInput;
  idempotencyKey?: string;
};

export type MessagePollResult = {
  channel: string;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds: number | null;
  durationHours: number | null;
  via: "direct" | "gateway";
  result?: {
    messageId: string;
    toJid?: string;
    channelId?: string;
    conversationId?: string;
    pollId?: string;
  };
  dryRun?: boolean;
};

function buildMessagePollResult(params: {
  channel: string;
  to: string;
  normalized: {
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number | null;
    durationHours?: number | null;
  };
  via: MessagePollResult["via"];
  result?: MessagePollResult["result"];
  dryRun?: boolean;
}): MessagePollResult {
  return {
    channel: params.channel,
    to: params.to,
    question: params.normalized.question,
    options: params.normalized.options,
    maxSelections: params.normalized.maxSelections,
    durationSeconds: params.normalized.durationSeconds ?? null,
    durationHours: params.normalized.durationHours ?? null,
    via: params.via,
    ...(params.dryRun ? { dryRun: true } : { result: params.result }),
  };
}

function assertPollOptionSupport(params: {
  channel: string;
  outbound: NonNullable<ReturnType<typeof resolveRequiredPlugin>["outbound"]>;
  durationSeconds?: number;
  isAnonymous?: boolean;
}): void {
  if (
    typeof params.durationSeconds === "number" &&
    params.outbound.supportsPollDurationSeconds !== true
  ) {
    throw new Error(`durationSeconds is not supported for ${params.channel} polls`);
  }
  if (typeof params.isAnonymous === "boolean" && params.outbound.supportsAnonymousPolls !== true) {
    throw new Error(`isAnonymous is not supported for ${params.channel} polls`);
  }
}

async function resolveRequiredChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): Promise<string> {
  const selection = await resolveMessageChannelSelection({
    cfg: params.cfg,
    channel: params.channel,
  });
  return selection.channel;
}

function resolveRequiredPlugin(channel: string, cfg: OpenClawConfig) {
  const plugin = resolveOutboundChannelPlugin({ channel, cfg });
  if (!plugin) {
    throw new Error(`Unknown channel: ${channel}`);
  }
  return plugin;
}

function payloadRequiresDurablePayloadTransport(payload: ReplyPayload): boolean {
  return (
    payload.presentation !== undefined ||
    payload.delivery !== undefined ||
    payload.interactive !== undefined ||
    (payload.channelData !== undefined && Object.keys(payload.channelData).length > 0)
  );
}

function mergeDurableRequirements(
  target: DurableFinalDeliveryRequirements,
  source: DurableFinalDeliveryRequirements,
): DurableFinalDeliveryRequirements {
  for (const [capability, required] of Object.entries(source) as Array<
    [keyof DurableFinalDeliveryRequirements, boolean | undefined]
  >) {
    if (required === true) {
      target[capability] = true;
    }
  }
  return target;
}

function deriveRequiredMessageSendCapabilities(params: {
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean;
}): DurableFinalDeliveryRequirements {
  const requirements: DurableFinalDeliveryRequirements = { reconcileUnknownSend: true };
  for (const payload of params.payloads) {
    mergeDurableRequirements(
      requirements,
      deriveDurableFinalDeliveryRequirements({
        payload,
        replyToId: params.replyToId,
        threadId: params.threadId,
        silent: params.silent,
        payloadTransport: payloadRequiresDurablePayloadTransport(payload),
        batch: params.payloads.length > 1,
        reconcileUnknownSend: true,
      }),
    );
  }
  return requirements;
}

async function assertRequiredMessageSendDurability(params: {
  cfg: OpenClawConfig;
  channel: Exclude<string, "none">;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean;
}): Promise<void> {
  const support = await resolveOutboundDurableFinalDeliverySupport({
    cfg: params.cfg,
    channel: params.channel,
    requirements: deriveRequiredMessageSendCapabilities(params),
  });
  if (support.ok) {
    return;
  }
  const suffix =
    support.reason === "capability_mismatch" && support.capability
      ? `missing ${support.capability}`
      : support.reason;
  throw new Error(
    `Required durable message send is unsupported for ${params.channel}: ${suffix}. ` +
      'Use queuePolicy:"best_effort" for best-effort delivery, omit bestEffort:false in message-tool calls, or use a channel with required durable delivery support.',
  );
}

function resolveGatewayOptions(opts?: OutboundMessageGatewayOptionsInput) {
  return resolveOutboundMessageGatewayOptions(opts);
}

async function callMessageGateway<T>(params: {
  gateway?: OutboundMessageGatewayOptionsInput;
  method: string;
  params: Record<string, unknown>;
}): Promise<T> {
  const { callGatewayLeastPrivilege } = await loadMessageGatewayRuntime();
  const gateway = resolveGatewayOptions(params.gateway);
  return await callGatewayLeastPrivilege<T>({
    url: gateway.url,
    token: gateway.token,
    method: params.method,
    params: params.params,
    timeoutMs: gateway.timeoutMs,
    clientName: gateway.clientName,
    clientDisplayName: gateway.clientDisplayName,
    mode: gateway.mode,
  });
}

async function resolveMessageConfig(cfg?: OpenClawConfig): Promise<OpenClawConfig> {
  if (cfg) {
    return cfg;
  }
  const { getRuntimeConfig } = await loadMessageConfigRuntime();
  return getRuntimeConfig();
}

async function resolveGatewayIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageGatewayRuntime();
  return randomIdempotencyKey();
}

export async function sendMessage(params: MessageSendParams): Promise<MessageSendResult> {
  assertAgentSessionOwnerPairs([
    {
      ownerLabel: "sendMessage",
      agentId: params.agentId,
      sessionKey: params.requesterSessionKey,
      sessionKeyLabel: "requester session key",
    },
    {
      ownerLabel: "sendMessage",
      agentId: params.mirror?.agentId,
      sessionKey: params.mirror?.sessionKey,
      sessionKeyLabel: "mirror session key",
    },
  ]);
  const cfg = await resolveMessageConfig(params.cfg);
  const channel = await resolveRequiredChannel({ cfg, channel: params.channel });
  const plugin = resolveRequiredPlugin(channel, cfg);
  const deliveryMode = plugin.outbound?.deliveryMode ?? "direct";
  const mediaSources = [params.mediaUrl, ...(params.mediaUrls ?? [])].filter(
    (source): source is string => Boolean(source),
  );
  const hasRealMediaSource = mediaSources.some((source) => source !== SEND_BUFFER_MEDIA_URL);
  const shouldForwardBuffer =
    deliveryMode === "gateway" && Boolean(params.buffer) && !hasRealMediaSource;
  const mediaUrl = params.mediaUrl ?? (shouldForwardBuffer ? SEND_BUFFER_MEDIA_URL : undefined);
  const mediaUrls = params.mediaUrls ?? (shouldForwardBuffer ? [SEND_BUFFER_MEDIA_URL] : undefined);
  const outboundPayloads =
    params.payloads && params.payloads.length > 0
      ? params.payloads
      : [
          {
            text: params.content,
            mediaUrl,
            mediaUrls,
            audioAsVoice: params.asVoice === true,
          },
        ];
  const outboundPlan = createOutboundPayloadPlan(outboundPayloads);
  const normalizedPayloads = projectOutboundPayloadPlanForDelivery(outboundPlan);
  const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPlan);
  const mirrorText = mirrorProjection.text;
  const mirrorMediaUrls = mirrorProjection.mediaUrls;
  const primaryMediaUrl = mirrorMediaUrls[0] ?? mediaUrl ?? null;

  if (params.dryRun) {
    return {
      channel,
      to: params.to,
      via: deliveryMode === "gateway" ? "gateway" : "direct",
      mediaUrl: primaryMediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
      dryRun: true,
    };
  }

  if (deliveryMode !== "gateway" || params.gatewayOwnedDelivery === true) {
    const outboundChannel = channel;
    const resolvedTarget = resolveOutboundTarget({
      channel: outboundChannel,
      to: params.to,
      cfg,
      accountId: params.accountId,
      mode: "explicit",
    });
    if (!resolvedTarget.ok) {
      throw resolvedTarget.error;
    }

    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: params.agentId,
      sessionKey: params.requesterSessionKey ?? params.mirror?.sessionKey,
      conversationType: params.conversationType,
      requesterAccountId: params.requesterAccountId ?? params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
    });
    // Public queuePolicy:"required" is the exact-delivery contract preflighted below.
    // Lower-level queue-required callers must leave this internal opt-in unset.
    const requireUnknownSendReconciliation =
      params.requireUnknownSendReconciliation ?? params.queuePolicy === "required";
    if (requireUnknownSendReconciliation) {
      await assertRequiredMessageSendDurability({
        cfg,
        channel: outboundChannel,
        payloads: normalizedPayloads,
        replyToId: params.replyToId,
        threadId: params.threadId,
        silent: params.silent,
      });
    }
    const send = await sendDurableMessageBatch({
      cfg,
      channel: outboundChannel,
      to: resolvedTarget.to,
      session: outboundSession,
      accountId: params.accountId,
      conversationReadOrigin: params.conversationReadOrigin,
      payloads: normalizedPayloads,
      replyToId: params.replyToId,
      threadId: params.threadId,
      gifPlayback: params.gifPlayback,
      forceDocument: params.forceDocument,
      deps: params.deps,
      bestEffort: params.bestEffort,
      ...(requireUnknownSendReconciliation ? { requireUnknownSendReconciliation: true } : {}),
      durability:
        params.bestEffort || params.queuePolicy === "best_effort" ? "best_effort" : "required",
      signal: params.abortSignal,
      silent: params.silent,
      mediaAccess: params.mediaAccess,
      formatting: params.parseMode ? { parseMode: params.parseMode } : undefined,
      preparedMessageId: params.preparedMessageId,
      deliveryIntentId: params.deliveryIntentId,
      deliveryCompletion: params.deliveryCompletion,
      ...(params.onDeliveryIntent ? { onDeliveryIntent: params.onDeliveryIntent } : {}),
      ...(params.onDeliveryResult ? { onDeliveryResult: params.onDeliveryResult } : {}),
      ...(params.onDeliveredPayload ? { onDeliveredPayload: params.onDeliveredPayload } : {}),
      mirror: params.mirror
        ? {
            ...params.mirror,
            text: mirrorText || params.content,
            mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
            idempotencyKey: params.mirror.idempotencyKey ?? params.idempotencyKey,
          }
        : undefined,
    });
    if (!params.bestEffort && (send.status === "failed" || send.status === "partial_failed")) {
      throw send.error;
    }
    const results = send.status === "sent" || send.status === "partial_failed" ? send.results : [];
    const payloadOutcomes = serializeDurableMessagePayloadOutcomes(send.payloadOutcomes);

    return {
      channel,
      to: params.to,
      via: "direct",
      mediaUrl: primaryMediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
      result: results.at(-1),
      deliveryStatus: send.status,
      ...(send.status === "failed" || send.status === "partial_failed"
        ? { error: formatErrorMessage(send.error) }
        : {}),
      ...(send.status === "partial_failed" ? { sentBeforeError: true as const } : {}),
      ...(payloadOutcomes ? { payloadOutcomes } : {}),
    };
  }

  const result = await callMessageGateway<{ messageId: string }>({
    gateway: params.gateway,
    method: "send",
    params: {
      to: params.to,
      message: params.content,
      mediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : mediaUrls,
      buffer: shouldForwardBuffer ? params.buffer : undefined,
      filename: shouldForwardBuffer ? params.filename : undefined,
      contentType: shouldForwardBuffer ? params.contentType : undefined,
      asVoice: params.asVoice,
      gifPlayback: params.gifPlayback,
      accountId: params.accountId,
      agentId: params.agentId,
      channel,
      replyToId: params.replyToId,
      threadId: params.threadId != null ? String(params.threadId) : undefined,
      forceDocument: params.forceDocument,
      silent: params.silent,
      parseMode: params.parseMode,
      sessionKey: params.mirror?.sessionKey,
      idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey),
    },
  });

  return {
    channel,
    to: params.to,
    via: "gateway",
    mediaUrl: primaryMediaUrl,
    mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
    result,
  };
}

export async function sendPoll(params: MessagePollParams): Promise<MessagePollResult> {
  const cfg = await resolveMessageConfig(params.cfg);
  const channel = await resolveRequiredChannel({ cfg, channel: params.channel });

  const pollInput: PollInput = {
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    durationSeconds: params.durationSeconds,
    durationHours: params.durationHours,
  };
  const plugin = resolveRequiredPlugin(channel, cfg);
  const outbound = plugin?.outbound;
  if (!outbound?.sendPoll) {
    throw new Error(`Unsupported poll channel: ${channel}`);
  }
  const deliveryMode = outbound.deliveryMode ?? "direct";
  const normalized = outbound.pollMaxOptions
    ? normalizePollInput(pollInput, { maxOptions: outbound.pollMaxOptions })
    : normalizePollInput(pollInput);

  if (params.dryRun) {
    return buildMessagePollResult({
      channel,
      to: params.to,
      normalized,
      via: deliveryMode === "gateway" ? "gateway" : "direct",
      dryRun: true,
    });
  }

  assertPollOptionSupport({
    channel,
    outbound,
    durationSeconds: params.durationSeconds,
    isAnonymous: params.isAnonymous,
  });

  if (deliveryMode !== "gateway") {
    const resolvedTarget = resolveOutboundTarget({
      channel,
      to: params.to,
      cfg,
      accountId: params.accountId,
      mode: "explicit",
    });
    if (!resolvedTarget.ok) {
      throw resolvedTarget.error;
    }

    const result = await outbound.sendPoll({
      cfg,
      to: resolvedTarget.to,
      poll: normalized,
      accountId: params.accountId,
      threadId: params.threadId,
      silent: params.silent,
      isAnonymous: params.isAnonymous,
    });

    return buildMessagePollResult({
      channel,
      to: params.to,
      normalized,
      via: "direct",
      result,
    });
  }

  const result = await callMessageGateway<{
    messageId: string;
    toJid?: string;
    channelId?: string;
    conversationId?: string;
    pollId?: string;
  }>({
    gateway: params.gateway,
    method: "poll",
    params: {
      to: params.to,
      question: normalized.question,
      options: normalized.options,
      maxSelections: normalized.maxSelections,
      durationSeconds: normalized.durationSeconds,
      durationHours: normalized.durationHours,
      threadId: params.threadId,
      silent: params.silent,
      isAnonymous: params.isAnonymous,
      channel,
      accountId: params.accountId,
      idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey),
    },
  });

  return buildMessagePollResult({
    channel,
    to: params.to,
    normalized,
    via: "gateway",
    result,
  });
}
