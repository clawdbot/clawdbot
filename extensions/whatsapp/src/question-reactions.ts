// WhatsApp transport binding for numbered ask_user reactions.
import type { WAMessage } from "baileys";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";

type WhatsAppQuestionReactionIdentity = {
  accountId: string;
  remoteJid: string;
  messageId: string;
};

function buildKey(identity: WhatsAppQuestionReactionIdentity): string | undefined {
  const parts = [identity.accountId, identity.remoteJid, identity.messageId].map((part) =>
    part.trim(),
  );
  return parts.every(Boolean) ? parts.join(":") : undefined;
}

const questionReactionTargets = createQuestionReactionTargetStore({
  channel: "whatsapp",
  channelDisplayName: "WhatsApp",
  buildKey,
  registerChannelDelivery: questionGatewayRuntime.registerChannelDelivery,
  resolveReaction: questionGatewayRuntime.resolveReaction,
});

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
    registered =
      questionReactionTargets.register(binding, { accountId, ...identity }) || registered;
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
  return await questionReactionTargets.resolve({
    identities: candidates.map((remoteJid) => ({
      accountId: params.accountId,
      remoteJid,
      messageId,
    })),
    optionIndex,
    cfg: params.cfg,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    logDebug: params.logDebug,
  });
}
