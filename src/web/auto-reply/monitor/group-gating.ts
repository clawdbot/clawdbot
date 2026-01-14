import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import type { loadConfig } from "../../../config/config.js";
import { normalizeE164 } from "../../../utils.js";
import type { MentionConfig } from "../mentions.js";
import {
  buildMentionConfig,
  debugMention,
  resolveOwnerList,
} from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { isStatusCommand, stripMentionsForCommand } from "./commands.js";
import {
  resolveGroupActivationFor,
  resolveGroupPolicyFor,
} from "./group-activation.js";
import { noteGroupMember } from "./group-members.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMsg) {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) return false;
  const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
  return owners.includes(sender);
}

export function applyGroupGating(params: {
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
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
}) {
  const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
  if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
    params.logVerbose(
      `Skipping group message ${params.conversationId} (not in allowlist)`,
    );
    return { shouldProcess: false };
  }

  noteGroupMember(
    params.groupMemberNames,
    params.groupHistoryKey,
    params.msg.senderE164,
    params.msg.senderName,
  );

  const mentionConfig = buildMentionConfig(params.cfg, params.agentId);
  const commandBody = stripMentionsForCommand(
    params.msg.body,
    mentionConfig.mentionRegexes,
    params.msg.selfE164,
  );
  const activationCommand = parseActivationCommand(commandBody);
  const owner = isOwnerSender(params.baseMentionConfig, params.msg);
  const statusCommand = isStatusCommand(commandBody);
  const shouldBypassMention =
    owner && (activationCommand.hasCommand || statusCommand);

  if (activationCommand.hasCommand && !owner) {
    params.logVerbose(
      `Ignoring /activation from non-owner in group ${params.conversationId}`,
    );
    return { shouldProcess: false };
  }

  if (!shouldBypassMention) {
    const history = params.groupHistories.get(params.groupHistoryKey) ?? [];
    const sender =
      params.msg.senderName && params.msg.senderE164
        ? `${params.msg.senderName} (${params.msg.senderE164})`
        : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
    history.push({
      sender,
      body: params.msg.body,
      timestamp: params.msg.timestamp,
      id: params.msg.id,
      senderJid: params.msg.senderJid,
    });
    while (history.length > params.groupHistoryLimit) history.shift();
    params.groupHistories.set(params.groupHistoryKey, history);
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
  params.msg.wasMentioned = wasMentioned;
  const activation = resolveGroupActivationFor({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
  });
  const requireMention = activation !== "always";
  if (!shouldBypassMention && requireMention && !wasMentioned) {
    params.logVerbose(
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
    return { shouldProcess: false };
  }

  return { shouldProcess: true };
}
