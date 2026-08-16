// iMessage transport binding for numbered ask_user reactions.
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveIMessageReactionContext } from "./monitor/reaction-context.js";
import type { IMessagePayload } from "./monitor/types.js";

function normalizeGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}

type IMessageQuestionReactionIdentity = { accountId: string; messageGuid: string };

function buildKey(identity: IMessageQuestionReactionIdentity): string | null {
  const account = identity.accountId.trim();
  const guid = normalizeGuid(identity.messageGuid);
  return account && guid ? `${account}:${guid}` : null;
}

const questionReactionTargets = createQuestionReactionTargetStore({
  channel: "imessage",
  channelDisplayName: "iMessage",
  buildKey,
  registerChannelDelivery: questionGatewayRuntime.registerChannelDelivery,
  resolveReaction: questionGatewayRuntime.resolveReaction,
});

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
    if (/^\d+$/u.test(normalizeGuid(guid))) {
      continue;
    }
    registered =
      questionReactionTargets.register(binding, {
        accountId: params.accountId,
        messageGuid: guid,
      }) || registered;
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
  return questionReactionTargets.has(
    reaction.guids.map((messageGuid) => ({ accountId: params.accountId, messageGuid })),
  );
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
  return await questionReactionTargets.resolve({
    identities: reaction.guids.map((messageGuid) => ({
      accountId: params.accountId,
      messageGuid,
    })),
    optionIndex,
    cfg: params.cfg,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    logDebug: params.logDebug,
  });
}
