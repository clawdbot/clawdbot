// Signal transport binding for numbered ask_user reactions.
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveSignalTarget } from "./aliases.js";
import {
  resolveSignalApprovalConversationKey,
  resolveSignalApprovalTargetAuthorKeys,
} from "./approval-reactions.js";

const TARGET_TTL_MS = 24 * 60 * 60 * 1_000;

type SignalQuestionReactionTarget = {
  questionId: string;
  optionValues: string[];
  targetAuthorKeys: string[];
  terminal: boolean;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

const targets = new Map<string, SignalQuestionReactionTarget>();

function storeTarget(
  key: string,
  binding: { questionId: string; optionValues: string[] },
  targetAuthorKeys: string[],
): void {
  const existing = targets.get(key);
  if (existing) {
    clearTimeout(existing.cleanupTimer);
  }
  const target: SignalQuestionReactionTarget = {
    ...binding,
    targetAuthorKeys,
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
    deliveryId: `signal-reaction:${key}`,
    finalize: () => {
      target.terminal = true;
    },
  });
}

function buildKey(accountId: string, conversationKey: string, messageId: string): string | null {
  const values = [accountId, conversationKey, messageId].map((value) => value.trim());
  return values.every(Boolean) ? values.join(":") : null;
}

function resolveConversationKey(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): string | null {
  try {
    return (
      resolveSignalTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        input: params.to,
      })?.to ?? resolveSignalApprovalConversationKey(params.to)
    );
  } catch {
    return resolveSignalApprovalConversationKey(params.to);
  }
}

export function registerSignalQuestionReactionTargetForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: { channel: string; to: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): boolean {
  const binding = questionGatewayRuntime.readReactionBinding(params.payload);
  if (params.target.channel !== "signal" || !binding) {
    return false;
  }
  const conversationKey = resolveConversationKey({ cfg: params.cfg, ...params.target });
  const targetAuthorKeys = resolveSignalApprovalTargetAuthorKeys(params);
  if (!conversationKey || targetAuthorKeys.length === 0) {
    return false;
  }
  const accountId = normalizeAccountId(params.target.accountId ?? undefined);
  let registered = false;
  for (const result of params.results) {
    const messageId = result.channel === "signal" ? result.messageId.trim() : "";
    const key =
      messageId && messageId !== "unknown" ? buildKey(accountId, conversationKey, messageId) : null;
    if (!key) {
      continue;
    }
    storeTarget(key, binding, targetAuthorKeys);
    registered = true;
  }
  return registered;
}

export async function maybeResolveSignalQuestionReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationKey: string;
  messageId: string;
  reactionKey: string;
  isRemove: boolean;
  actorId: string;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  gatewayUrl?: string;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  if (params.isRemove) {
    return false;
  }
  const optionIndex = questionGatewayRuntime.resolveReactionIndex(params.reactionKey);
  const key = buildKey(params.accountId, params.conversationKey, params.messageId);
  if (optionIndex === undefined || !key) {
    return false;
  }
  const target = targets.get(key);
  if (!target) {
    return false;
  }
  const authorKeys = resolveSignalApprovalTargetAuthorKeys(params);
  if (!authorKeys.some((authorKey) => target.targetAuthorKeys.includes(authorKey))) {
    return false;
  }
  if (target.expiresAtMs <= Date.now() || target.terminal) {
    target.terminal = true;
    params.logDebug?.(`signal: stale question reaction ignored id=${target.questionId}`);
    return true;
  }
  const optionValue = target.optionValues[optionIndex];
  if (!optionValue) {
    params.logDebug?.(`signal: out-of-range question reaction ignored id=${target.questionId}`);
    return true;
  }
  try {
    const result = await questionGatewayRuntime.resolveReaction({
      cfg: params.cfg,
      questionId: target.questionId,
      optionValue,
      senderId: params.actorId,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: `Signal question (${params.actorId})`,
    });
    target.terminal = result?.status === "answered" || result?.status === "already-terminal";
    if (result?.status === "already-terminal") {
      params.logDebug?.(`signal: stale question reaction ignored id=${target.questionId}`);
    }
  } catch (error) {
    params.logDebug?.(`signal: question reaction failed id=${target.questionId}: ${String(error)}`);
  }
  return true;
}
