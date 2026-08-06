// WhatsApp transport binding for numbered ask_user reactions.
import type { WAMessage } from "baileys";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";

const TARGET_TTL_MS = 24 * 60 * 60 * 1_000;

type WhatsAppQuestionReactionTarget = {
  questionId: string;
  optionValues: string[];
  terminal: boolean;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

const targets = new Map<string, WhatsAppQuestionReactionTarget>();

function storeTarget(key: string, binding: { questionId: string; optionValues: string[] }): void {
  const existing = targets.get(key);
  if (existing) {
    clearTimeout(existing.cleanupTimer);
  }
  const target: WhatsAppQuestionReactionTarget = {
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
    deliveryId: `whatsapp-reaction:${key}`,
    finalize: () => {
      target.terminal = true;
    },
  });
}

function buildKey(accountId: string, remoteJid: string, messageId: string): string | undefined {
  const parts = [accountId, remoteJid, messageId].map((part) => part.trim());
  return parts.every(Boolean) ? parts.join(":") : undefined;
}

function addCandidate(values: string[], value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

function listDeliveredIdentities(
  results: readonly OutboundDeliveryResult[],
): Array<{ messageId: string; remoteJid: string }> {
  const identities: Array<{ messageId: string; remoteJid: string }> = [];
  const seen = new Set<string>();
  const add = (messageId?: string, remoteJid?: string) => {
    const id = messageId?.trim() ?? "";
    const jid = remoteJid?.trim() ?? "";
    const key = `${jid}:${id}`;
    if (id && id !== "unknown" && jid && !seen.has(key)) {
      seen.add(key);
      identities.push({ messageId: id, remoteJid: jid });
    }
  };
  for (const result of results) {
    if (result.channel !== "whatsapp") {
      continue;
    }
    add(result.messageId, result.toJid);
    for (const raw of result.receipt?.raw ?? []) {
      add(raw.messageId, raw.toJid);
    }
    for (const part of result.receipt?.parts ?? []) {
      add(part.raw?.messageId ?? part.platformMessageId, part.raw?.toJid);
    }
  }
  return identities;
}

export function registerWhatsAppQuestionReactionTargetForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
}): boolean {
  const binding = questionGatewayRuntime.readReactionBinding(params.payload);
  if (params.target.channel !== "whatsapp" || !binding) {
    return false;
  }
  const accountId = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.target.accountId,
  }).accountId;
  let registered = false;
  for (const identity of listDeliveredIdentities(params.results)) {
    const key = buildKey(accountId, identity.remoteJid, identity.messageId);
    if (!key) {
      continue;
    }
    storeTarget(key, binding);
    registered = true;
  }
  return registered;
}

export async function maybeResolveWhatsAppQuestionReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WAMessage;
  senderId: string;
  gatewayUrl?: string;
  resolveReactionTargetJids?: (jid: string) => Promise<readonly string[]>;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  const reaction = params.msg.message?.reactionMessage;
  const reactionKey = reaction?.text?.trim() ?? "";
  const messageId = reaction?.key?.id?.trim() ?? "";
  const optionIndex = questionGatewayRuntime.resolveReactionIndex(reactionKey);
  if (optionIndex === undefined || !messageId) {
    return false;
  }
  const remoteJids: string[] = [];
  addCandidate(remoteJids, reaction?.key?.remoteJid);
  addCandidate(remoteJids, params.msg.key?.remoteJid);
  const candidates: string[] = [];
  for (const remoteJid of remoteJids) {
    addCandidate(candidates, remoteJid);
    for (const mapped of (await params.resolveReactionTargetJids?.(remoteJid)) ?? []) {
      addCandidate(candidates, mapped);
    }
  }
  let matched: { key: string; target: WhatsAppQuestionReactionTarget } | undefined;
  for (const remoteJid of candidates) {
    const key = buildKey(params.accountId, remoteJid, messageId);
    const target = key ? targets.get(key) : undefined;
    if (key && target) {
      matched = { key, target };
      break;
    }
  }
  if (!matched) {
    return false;
  }
  if (matched.target.expiresAtMs <= Date.now() || matched.target.terminal) {
    matched.target.terminal = true;
    params.logDebug?.(`whatsapp: stale question reaction ignored id=${matched.target.questionId}`);
    return true;
  }
  const optionValue = matched.target.optionValues[optionIndex];
  if (!optionValue) {
    params.logDebug?.(
      `whatsapp: out-of-range question reaction ignored id=${matched.target.questionId}`,
    );
    return true;
  }
  try {
    const result = await questionGatewayRuntime.resolveReaction({
      cfg: params.cfg,
      questionId: matched.target.questionId,
      optionValue,
      senderId: params.senderId,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: `WhatsApp question (${params.senderId})`,
    });
    matched.target.terminal =
      result?.status === "answered" || result?.status === "already-terminal";
    if (result?.status === "already-terminal") {
      params.logDebug?.(
        `whatsapp: stale question reaction ignored id=${matched.target.questionId}`,
      );
    }
  } catch (error) {
    params.logDebug?.(
      `whatsapp: question reaction failed id=${matched.target.questionId}: ${String(error)}`,
    );
  }
  return true;
}

export function clearWhatsAppQuestionReactionTargetsForTest(): void {
  for (const target of targets.values()) {
    clearTimeout(target.cleanupTimer);
  }
  targets.clear();
}
