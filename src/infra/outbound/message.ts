import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { callGateway, randomIdempotencyKey } from "../../gateway/call.js";
import type { PollInput } from "../../polls.js";
import { normalizePollInput } from "../../polls.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../../providers/plugins/index.js";
import type { ProviderId } from "../../providers/plugins/types.js";
import {
  deliverOutboundPayloads,
  type OutboundDeliveryResult,
  type OutboundSendDeps,
} from "./deliver.js";
import { resolveMessageProviderSelection } from "./provider-selection.js";
import type { OutboundProvider } from "./targets.js";
import { resolveOutboundTarget } from "./targets.js";

type GatewayCallMode = "cli" | "agent";

export type MessageGatewayOptions = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName?: GatewayCallMode;
  mode?: GatewayCallMode;
};

type MessageSendParams = {
  to: string;
  content: string;
  provider?: string;
  mediaUrl?: string;
  gifPlayback?: boolean;
  accountId?: string;
  dryRun?: boolean;
  bestEffort?: boolean;
  deps?: OutboundSendDeps;
  cfg?: ClawdbotConfig;
  gateway?: MessageGatewayOptions;
  idempotencyKey?: string;
};

export type MessageSendResult = {
  provider: string;
  to: string;
  via: "direct" | "gateway";
  mediaUrl: string | null;
  result?: OutboundDeliveryResult | { messageId: string };
  dryRun?: boolean;
};

type MessagePollParams = {
  to: string;
  question: string;
  options: string[];
  maxSelections?: number;
  durationHours?: number;
  provider?: string;
  dryRun?: boolean;
  cfg?: ClawdbotConfig;
  gateway?: MessageGatewayOptions;
  idempotencyKey?: string;
};

export type MessagePollResult = {
  provider: string;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
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

function resolveGatewayOptions(opts?: MessageGatewayOptions) {
  return {
    url: opts?.url,
    token: opts?.token,
    timeoutMs:
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.floor(opts.timeoutMs))
        : 10_000,
    clientName: opts?.clientName ?? "cli",
    mode: opts?.mode ?? "cli",
  };
}

export async function sendMessage(
  params: MessageSendParams,
): Promise<MessageSendResult> {
  const cfg = params.cfg ?? loadConfig();
  const provider =
    params.provider && params.provider.trim()
      ? normalizeProviderId(params.provider)
      : (await resolveMessageProviderSelection({ cfg })).provider;
  if (!provider) {
    throw new Error(`Unknown provider: ${params.provider}`);
  }
  const plugin = getProviderPlugin(provider as ProviderId);
  if (!plugin) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const deliveryMode = plugin.outbound?.deliveryMode ?? "direct";

  if (params.dryRun) {
    return {
      provider,
      to: params.to,
      via: deliveryMode === "gateway" ? "gateway" : "direct",
      mediaUrl: params.mediaUrl ?? null,
      dryRun: true,
    };
  }

  if (deliveryMode !== "gateway") {
    const outboundProvider = provider as Exclude<OutboundProvider, "none">;
    const resolvedTarget = resolveOutboundTarget({
      provider: outboundProvider,
      to: params.to,
      cfg,
      accountId: params.accountId,
      mode: "explicit",
    });
    if (!resolvedTarget.ok) throw resolvedTarget.error;

    const results = await deliverOutboundPayloads({
      cfg,
      provider: outboundProvider,
      to: resolvedTarget.to,
      accountId: params.accountId,
      payloads: [{ text: params.content, mediaUrl: params.mediaUrl }],
      gifPlayback: params.gifPlayback,
      deps: params.deps,
      bestEffort: params.bestEffort,
    });

    return {
      provider,
      to: params.to,
      via: "direct",
      mediaUrl: params.mediaUrl ?? null,
      result: results.at(-1),
    };
  }

  const gateway = resolveGatewayOptions(params.gateway);
  const result = await callGateway<{ messageId: string }>({
    url: gateway.url,
    token: gateway.token,
    method: "send",
    params: {
      to: params.to,
      message: params.content,
      mediaUrl: params.mediaUrl,
      gifPlayback: params.gifPlayback,
      accountId: params.accountId,
      provider,
      idempotencyKey: params.idempotencyKey ?? randomIdempotencyKey(),
    },
    timeoutMs: gateway.timeoutMs,
    clientName: gateway.clientName,
    mode: gateway.mode,
  });

  return {
    provider,
    to: params.to,
    via: "gateway",
    mediaUrl: params.mediaUrl ?? null,
    result,
  };
}

export async function sendPoll(
  params: MessagePollParams,
): Promise<MessagePollResult> {
  const cfg = params.cfg ?? loadConfig();
  const provider =
    params.provider && params.provider.trim()
      ? normalizeProviderId(params.provider)
      : (await resolveMessageProviderSelection({ cfg })).provider;
  if (!provider) {
    throw new Error(`Unknown provider: ${params.provider}`);
  }

  const pollInput: PollInput = {
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    durationHours: params.durationHours,
  };
  const plugin = getProviderPlugin(provider as ProviderId);
  const outbound = plugin?.outbound;
  if (!outbound?.sendPoll) {
    throw new Error(`Unsupported poll provider: ${provider}`);
  }
  const normalized = outbound.pollMaxOptions
    ? normalizePollInput(pollInput, { maxOptions: outbound.pollMaxOptions })
    : normalizePollInput(pollInput);

  if (params.dryRun) {
    return {
      provider,
      to: params.to,
      question: normalized.question,
      options: normalized.options,
      maxSelections: normalized.maxSelections,
      durationHours: normalized.durationHours ?? null,
      via: "gateway",
      dryRun: true,
    };
  }

  const gateway = resolveGatewayOptions(params.gateway);
  const result = await callGateway<{
    messageId: string;
    toJid?: string;
    channelId?: string;
    conversationId?: string;
    pollId?: string;
  }>({
    url: gateway.url,
    token: gateway.token,
    method: "poll",
    params: {
      to: params.to,
      question: normalized.question,
      options: normalized.options,
      maxSelections: normalized.maxSelections,
      durationHours: normalized.durationHours,
      provider,
      idempotencyKey: params.idempotencyKey ?? randomIdempotencyKey(),
    },
    timeoutMs: gateway.timeoutMs,
    clientName: gateway.clientName,
    mode: gateway.mode,
  });

  return {
    provider,
    to: params.to,
    question: normalized.question,
    options: normalized.options,
    maxSelections: normalized.maxSelections,
    durationHours: normalized.durationHours ?? null,
    via: "gateway",
    result,
  };
}
