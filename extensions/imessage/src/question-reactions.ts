// iMessage transport binding for numbered ask_user reactions.
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveIMessageReactionContext } from "./monitor/reaction-context.js";
import type { IMessagePayload } from "./monitor/types.js";

const TARGET_TTL_MS = 24 * 60 * 60 * 1_000;

type IMessageQuestionReactionTarget = {
  questionId: string;
  optionValues: string[];
  terminal: boolean;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

const targets = new Map<string, IMessageQuestionReactionTarget>();

function storeTarget(key: string, binding: { questionId: string; optionValues: string[] }): void {
  const existing = targets.get(key);
  if (existing) {
    clearTimeout(existing.cleanupTimer);
  }
  const target: IMessageQuestionReactionTarget = {
    ...binding,
    terminal: false,
    expiresAtMs: Date.now() + TARGET_TTL_MS,
    cleanupTimer: setTimeout(() => {
      if (targets.get(key) === target) {
        targets.delete(key);
      }
    }, TARGET_TTL_MS),
  };
  target.cleanupTimer.unref?.();
  targets.set(key, target);
  questionGatewayRuntime.registerChannelDelivery({
    questionId: binding.questionId,
    deliveryId: `imessage-reaction:${key}`,
    finalize: () => {
      target.terminal = true;
    },
  });
}

function normalizeGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}

function buildKey(accountId: string, messageGuid: string): string | null {
  const account = accountId.trim();
  const guid = normalizeGuid(messageGuid);
  return account && guid ? `${account}:${guid}` : null;
}

function reactionCandidates(
  message: IMessagePayload,
  bodyText: string,
): {
  action: "added" | "removed";
  emoji: string;
  guids: string[];
} | null {
  const reaction = resolveIMessageReactionContext(message, bodyText);
  if (!reaction) {
    return null;
  }
  const guids = Array.from(
    new Set(
      [...(reaction.targetGuids ?? []), reaction.targetGuid ?? ""]
        .map(normalizeGuid)
        .filter(Boolean),
    ),
  );
  return guids.length > 0 ? { action: reaction.action, emoji: reaction.emoji, guids } : null;
}

export function registerIMessageQuestionReactionTargetForDeliveredPayload(params: {
  accountId: string;
  target: { channel: string };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
}): boolean {
  const binding = questionGatewayRuntime.readReactionBinding(params.payload);
  if (params.target.channel !== "imessage" || !binding) {
    return false;
  }
  let registered = false;
  for (const result of params.results) {
    if (result.channel !== "imessage") {
      continue;
    }
    const guid =
      typeof result.meta?.imessageMessageGuid === "string"
        ? result.meta.imessageMessageGuid
        : result.messageId;
    const key = buildKey(params.accountId, guid);
    if (!key || /^\d+$/u.test(normalizeGuid(guid))) {
      continue;
    }
    storeTarget(key, binding);
    registered = true;
  }
  return registered;
}

export function hasIMessageQuestionReactionTarget(params: {
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
}): boolean {
  const reaction = reactionCandidates(params.message, params.bodyText);
  if (
    !reaction ||
    reaction.action !== "added" ||
    questionGatewayRuntime.resolveReactionIndex(reaction.emoji) === undefined
  ) {
    return false;
  }
  return reaction.guids.some((guid) => {
    const key = buildKey(params.accountId, guid);
    return key ? targets.has(key) : false;
  });
}

export async function maybeResolveIMessageQuestionReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  bodyText: string;
  senderId: string;
  gatewayUrl?: string;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  const reaction = reactionCandidates(params.message, params.bodyText);
  const optionIndex = reaction
    ? questionGatewayRuntime.resolveReactionIndex(reaction.emoji)
    : undefined;
  if (!reaction || reaction.action === "removed" || optionIndex === undefined) {
    return false;
  }
  let target: IMessageQuestionReactionTarget | undefined;
  for (const guid of reaction.guids) {
    const key = buildKey(params.accountId, guid);
    target = key ? targets.get(key) : undefined;
    if (target) {
      break;
    }
  }
  if (!target) {
    return false;
  }
  if (target.expiresAtMs <= Date.now() || target.terminal) {
    target.terminal = true;
    params.logDebug?.(`imessage: stale question reaction ignored id=${target.questionId}`);
    return true;
  }
  const optionValue = target.optionValues[optionIndex];
  if (!optionValue) {
    params.logDebug?.(`imessage: out-of-range question reaction ignored id=${target.questionId}`);
    return true;
  }
  try {
    const result = await questionGatewayRuntime.resolveReaction({
      cfg: params.cfg,
      questionId: target.questionId,
      optionValue,
      senderId: params.senderId,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: `iMessage question (${params.senderId})`,
    });
    target.terminal = result?.status === "answered" || result?.status === "already-terminal";
    if (result?.status === "already-terminal") {
      params.logDebug?.(`imessage: stale question reaction ignored id=${target.questionId}`);
    }
  } catch (error) {
    params.logDebug?.(
      `imessage: question reaction failed id=${target.questionId}: ${String(error)}`,
    );
  }
  return true;
}

export function clearIMessageQuestionReactionTargetsForTest(): void {
  for (const target of targets.values()) {
    clearTimeout(target.cleanupTimer);
  }
  targets.clear();
}
