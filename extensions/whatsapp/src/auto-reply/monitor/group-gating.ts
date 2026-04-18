import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
  identitiesOverlap,
} from "../../identity.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import {
  hasControlCommand,
  implicitMentionKindWhen,
  normalizeE164,
  parseActivationCommand,
  recordPendingHistoryEntryIfEnabled,
  resolveInboundMentionDecision,
} from "./group-gating.runtime.js";
import { noteGroupMember } from "./group-members.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

type ApplyGroupGatingParams = {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  selfChatMode?: boolean;
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
};

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMsg) {
  const sender = normalizeE164(getSenderIdentity(msg).e164 ?? "");
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(baseMentionConfig, getSelfIdentity(msg).e164 ?? undefined);
  return owners.includes(sender);
}

function recordPendingGroupHistoryEntry(params: {
  msg: WebInboundMsg;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  groupHistoryLimit: number;
}) {
  const senderIdentity = getSenderIdentity(params.msg);
  const sender =
    senderIdentity.name && senderIdentity.e164
      ? `${senderIdentity.name} (${senderIdentity.e164})`
      : (senderIdentity.name ??
        senderIdentity.e164 ??
        getPrimaryIdentityId(senderIdentity) ??
        "Unknown");
  recordPendingHistoryEntryIfEnabled({
    historyMap: params.groupHistories,
    historyKey: params.groupHistoryKey,
    limit: params.groupHistoryLimit,
    entry: {
      sender,
      body: params.msg.body,
      timestamp: params.msg.timestamp,
      id: params.msg.id,
      senderJid: senderIdentity.jid ?? params.msg.senderJid,
    },
  });
}

function skipGroupMessageAndStoreHistory(params: ApplyGroupGatingParams, verboseMessage: string) {
  params.logVerbose(verboseMessage);
  recordPendingGroupHistoryEntry({
    msg: params.msg,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    groupHistoryLimit: params.groupHistoryLimit,
  });
  return { shouldProcess: false } as const;
}

export async function applyGroupGating(params: ApplyGroupGatingParams) {
  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg, params.authDir);
  const inboundPolicy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.msg.accountId,
    selfE164: self.e164 ?? null,
  });
  const conversationGroupPolicy = inboundPolicy.resolveConversationGroupPolicy(
    params.conversationId,
  );
  if (conversationGroupPolicy.allowlistEnabled && !conversationGroupPolicy.allowed) {
    params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
    return { shouldProcess: false };
  }

  noteGroupMember(
    params.groupMemberNames,
    params.groupHistoryKey,
    sender.e164 ?? undefined,
    sender.name ?? undefined,
  );

  const baseMentionConfig = {
    ...params.baseMentionConfig,
    allowFrom: inboundPolicy.configuredAllowFrom,
  };
  const mentionConfig = {
    ...buildMentionConfig(params.cfg, params.agentId),
    allowFrom: inboundPolicy.configuredAllowFrom,
  };
  const commandBody = stripMentionsForCommand(
    params.msg.body,
    mentionConfig.mentionRegexes,
    self.e164,
  );
  const activationCommand = parseActivationCommand(commandBody);
  const owner = isOwnerSender(baseMentionConfig, params.msg);
  const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);

  if (activationCommand.hasCommand && !owner) {
    return skipGroupMessageAndStoreHistory(
      params,
      `Ignoring /activation from non-owner in group ${params.conversationId}`,
    );
  }

  const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
  params.replyLogger.debug(
    {
      conversationId: params.conversationId,
      wasMentioned: mentionDebug.wasMentioned,
      ...mentionDebug.details,
    },
    "group mention debug",
  );
  const wasMentioned = mentionDebug.wasMentioned;
  const activation = await resolveGroupActivationFor({
    cfg: params.cfg,
    accountId: inboundPolicy.account.accountId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
  });
  const requireMention = activation !== "always";
  const replyContext = getReplyContext(params.msg, params.authDir);
  const sharedNumberSelfChat = params.selfChatMode === true;
  // Detect reply-to-bot: compare JIDs, LIDs, and E.164 numbers.
  // WhatsApp may report the quoted message sender as either a phone JID
  // (xxxxx@s.whatsapp.net) or a LID (xxxxx@lid), so we compare both.
  // But in shared-number/selfChatMode setups, replies from the same self number
  // should not count as implicit bot mentions unless the message explicitly
  // mentioned the bot in text.
  const implicitReplyToSelf = sharedNumberSelfChat && identitiesOverlap(self, sender);
  const implicitMentionKinds = implicitMentionKindWhen(
    "quoted_bot",
    !implicitReplyToSelf && identitiesOverlap(self, replyContext?.sender),
  );
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned,
      implicitMentionKinds,
    },
    policy: {
      isGroup: true,
      requireMention,
      allowTextCommands: false,
      hasControlCommand: false,
      commandAuthorized: false,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned || shouldBypassMention;
  params.msg.wasMentioned = effectiveWasMentioned;
  if (!shouldBypassMention && requireMention && mentionDecision.shouldSkip) {
    return skipGroupMessageAndStoreHistory(
      params,
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
  }

  return { shouldProcess: true };
}
