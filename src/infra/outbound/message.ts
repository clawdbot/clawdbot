import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { deriveDurableFinalDeliveryRequirements } from "../../channels/message/capabilities.js";
import { sendDurableMessageBatch } from "../../channels/message/runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { PollInput } from "../../polls.js";
import { normalizePollInput } from "../../polls.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import {
  resolveOutboundDurableFinalDeliverySupport,
  type DurableFinalDeliveryRequirements,
  type OutboundDeliveryResult,
  type OutboundDeliveryQueuePolicy,
  type OutboundSendDeps,
} from "./deliver.js";
import type { OutboundMirror } from "./mirror.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForMirror,
} from "./payloads.js";
import { buildOutboundSessionContext } from "./session-context.js";
import { resolveOutboundTarget } from "./targets.js";

let messageConfigRuntimePromise: Promise<typeof import("./message.config.runtime.js")> | null =
  null;
let messageGatewayRuntimePromise: Promise<typeof import("./message.gateway.runtime.js")> | null =
  null;

function loadMessageConfigRuntime() {
  messageConfigRuntimePromise ??= import("./message.config.runtime.js");
  return messageConfigRuntimePromise;
}

function loadMessageGatewayRuntime() {
  messageGatewayRuntimePromise ??= import("./message.gateway.runtime.js");
  return messageGatewayRuntimePromise;
}

export type MessageGatewayOptions = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  mode?: GatewayClientMode;
};

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
  asVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  accountId?: string;
  replyToId?: string;
  threadId?: string | number;
  dryRun?: boolean;
  bestEffort?: boolean;
  queuePolicy?: OutboundDeliveryQueuePolicy;
  payloads?: ReplyPayload[];
  mediaAccess?: OutboundMediaAccess;
  deps?: OutboundSendDeps;
  cfg?: OpenClawConfig;
  gateway?: MessageGatewayOptions;
  idempotencyKey?: string;
  mirror?: OutboundMirror;
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
  gateway?: MessageGatewayOptions;
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
  via: "gateway";
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
    via: "gateway",
    ...(params.dryRun ? { dryRun: true } : { result: params.result }),
  };
}

async function resolveRequiredChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): Promise<string> {
  return (
    await resolveMessageChannelSelection({
      cfg: params.cfg,
      channel: params.channel,
    })
  ).channel;
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
  throw new Error(`Required durable message send is unsupported for ${params.channel}: ${suffix}`);
}

function resolveGatewayOptions(opts?: MessageGatewayOptions) {
  // Security: backend callers (tools/agents) must not accept user-controlled gateway URLs.
  // Use config-derived gateway target only.
  const url =
    opts?.mode === GATEWAY_CLIENT_MODES.BACKEND ||
    opts?.clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT
      ? undefined
      : opts?.url;
  return {
    url,
    token: opts?.token,
    timeoutMs:
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.floor(opts.timeoutMs))
        : 10_000,
    clientName: opts?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: opts?.clientDisplayName,
    mode: opts?.mode ?? GATEWAY_CLIENT_MODES.CLI,
  };
}

async function callMessageGateway<T>(params: {
  gateway?: MessageGatewayOptions;
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
  const cfg = await resolveMessageConfig(params.cfg);
  const channel = await resolveRequiredChannel({ cfg, channel: params.channel });
  const plugin = resolveRequiredPlugin(channel, cfg);
  const deliveryMode = plugin.outbound?.deliveryMode ?? "direct";
  const outboundPayloads =
    params.payloads && params.payloads.length > 0
      ? params.payloads
      : [
          {
            text: params.content,
            mediaUrl: params.mediaUrl,
            mediaUrls: params.mediaUrls,
            audioAsVoice: params.asVoice === true,
          },
        ];
  const outboundPlan = createOutboundPayloadPlan(outboundPayloads);
  const normalizedPayloads = projectOutboundPayloadPlanForDelivery(outboundPlan);
  const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPlan);
  const mirrorText = mirrorProjection.text;
  const mirrorMediaUrls = mirrorProjection.mediaUrls;
  const primaryMediaUrl = mirrorMediaUrls[0] ?? params.mediaUrl ?? null;

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

  if (deliveryMode !== "gateway") {
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
      requesterAccountId: params.requesterAccountId ?? params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
    });
    if (params.queuePolicy === "required") {
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
      payloads: normalizedPayloads,
      replyToId: params.replyToId,
      threadId: params.threadId,
      gifPlayback: params.gifPlayback,
      forceDocument: params.forceDocument,
      deps: params.deps,
      bestEffort: params.bestEffort,
      durability:
        params.bestEffort || params.queuePolicy === "best_effort" ? "best_effort" : "required",
      signal: params.abortSignal,
      silent: params.silent,
      mediaAccess: params.mediaAccess,
      formatting: params.parseMode ? { parseMode: params.parseMode } : undefined,
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

    return {
      channel,
      to: params.to,
      via: "direct",
      mediaUrl: primaryMediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
      result: results.at(-1),
    };
  }

  const result = await callMessageGateway<{ messageId: string }>({
    gateway: params.gateway,
    method: "send",
    params: {
      to: params.to,
      message: params.content,
      mediaUrl: params.mediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : params.mediaUrls,
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
  const normalized = outbound.pollMaxOptions
    ? normalizePollInput(pollInput, { maxOptions: outbound.pollMaxOptions })
    : normalizePollInput(pollInput);

  if (params.dryRun) {
    return buildMessagePollResult({
      channel,
      to: params.to,
      normalized,
      dryRun: true,
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
    result,
  });
}
