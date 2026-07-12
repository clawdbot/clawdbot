// Whatsapp plugin module implements group gating behavior.
import type { BuildMentionRegexesOptions } from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { resolveWhatsAppGroupsConfigPath } from "../../group-config-path.js";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
  identitiesOverlap,
} from "../../identity.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import {
  hasControlCommand,
  implicitMentionKindWhen,
  normalizeE164,
  parseActivationCommand,
  createChannelHistoryWindow,
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
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  mentionText?: string;
  deferMissingMention?: boolean;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  providerMentionPatterns?: BuildMentionRegexesOptions["providerPolicy"];
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  selfChatMode?: boolean;
  logVerbose: (msg: string) => void;
  replyLogger: {
    debug: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
};

const MAX_GROUP_DROP_WARNINGS = 100;
const groupDropWarned = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_GROUP_DROP_WARNINGS,
});

export function resetGroupDropWarningsForTests() {
  groupDropWarned.clear();
}

function shouldWarnForGroupDrop(warnKey: string): boolean {
  return !groupDropWarned.check(warnKey);
}

function isOwnerSender(
  baseMentionConfig: MentionConfig,
  msg: AdmittedWebInboundMessage,
  authDir?: string,
) {
  const sender = normalizeE164(getSenderIdentity(msg, authDir).e164 ?? "");
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(
    baseMentionConfig,
    getSelfIdentity(msg, authDir).e164 ?? undefined,
  );
  return owners.includes(sender);
}

function recordPendingGroupHistoryEntry(params: {
  msg: AdmittedWebInboundMessage;
  body?: string;
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
  createChannelHistoryWindow({ historyMap: params.groupHistories }).record({
    historyKey: params.groupHistoryKey,
    limit: params.groupHistoryLimit,
    entry: {
      sender,
      body: params.body ?? params.msg.payload.body,
      timestamp: params.msg.event.timestamp,
      id: params.msg.event.id,
      senderJid: senderIdentity.jid ?? params.msg.platform.senderJid,
    },
  });
}

function skipGroupMessageAndStoreHistory(
  params: ApplyGroupGatingParams,
  verboseMessage: string,
  body?: string,
) {
  params.logVerbose(verboseMessage);
  recordPendingGroupHistoryEntry({
    msg: params.msg,
    body,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    groupHistoryLimit: params.groupHistoryLimit,
  });
  return { shouldProcess: false } as const;
}

export async function applyGroupGating(params: ApplyGroupGatingParams) {
  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg, params.authDir);
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const conversationId = admission.conversation.id;
  const inboundPolicy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: admission.accountId,
    selfE164: self.e164 ?? null,
  });
  const conversationGroupPolicy = inboundPolicy.resolveConversationGroupPolicy(conversationId);
  if (conversationGroupPolicy.allowlistEnabled && !conversationGroupPolicy.allowed) {
    const accountId = inboundPolicy.account.accountId;
    const warnKey = `${accountId}:${conversationId}`;
    if (shouldWarnForGroupDrop(warnKey)) {
      const groupsPath = resolveWhatsAppGroupsConfigPath({ cfg: params.cfg, accountId });
      params.replyLogger.warn(
        { conversationId, accountId, groupsPath },
        `WhatsApp group ${conversationId} not in ${groupsPath} — inbound dropped. Add the group JID to ${groupsPath} (or add "*" there to admit all groups). Sender authorization still applies.`,
      );
    }
    params.logVerbose(
      `Dropping message from unregistered WhatsApp group ${conversationId}. Add the group JID to channels.whatsapp.groups, or add "*" there to admit all groups. Sender authorization still applies.`,
    );
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
    ...buildMentionConfig(params.cfg, params.agentId, {
      provider: "whatsapp",
      conversationId,
      providerPolicy: params.providerMentionPatterns,
    }),
    allowFrom: inboundPolicy.configuredAllowFrom,
  };
  const mentionMsg: AdmittedWebInboundMessage =
    params.mentionText !== undefined
      ? { ...params.msg, payload: { ...params.msg.payload, body: params.mentionText } }
      : {
          ...params.msg,
          payload: {
            ...params.msg.payload,
            body: params.msg.payload.commandBody ?? params.msg.payload.body,
          },
        };
  const commandBody = stripMentionsForCommand(
    mentionMsg.payload.body,
    mentionConfig.mentionRegexes,
    self.e164,
  );
  const activationCommand = parseActivationCommand(commandBody);
  const owner = isOwnerSender(baseMentionConfig, params.msg, params.authDir);
  const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);

  if (activationCommand.hasCommand && !owner) {
    return skipGroupMessageAndStoreHistory(
      params,
      `Ignoring /activation from non-owner in group ${conversationId}`,
    );
  }

  const mentionDebug = debugMention(mentionMsg, mentionConfig, params.authDir);
  params.replyLogger.debug(
    {
      conversationId,
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
    conversationId,
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
  // Carry the session activation and mention result together. Dispatch needs
  // both facts to distinguish an always-on group from a blocked unmentioned turn.
  params.msg.groupMention = { wasMentioned: effectiveWasMentioned, requireMention };
  if (!shouldBypassMention && requireMention && mentionDecision.shouldSkip) {
    if (params.deferMissingMention === true) {
      params.logVerbose(
        `Deferring group mention skip until audio preflight completes in ${conversationId}`,
      );
      return { shouldProcess: false, needsMentionText: true } as const;
    }
    return skipGroupMessageAndStoreHistory(
      params,
      `Group message stored for context (no mention detected) in ${conversationId}: ${mentionMsg.payload.body}`,
      params.mentionText,
    );
  }

  return { shouldProcess: true };
}
