import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import type { loadConfig } from "../../../config/config.js";
import { normalizeE164 } from "../../../utils.js";
import { resolveMentionGating } from "../../../channels/mention-gating.js";
import {
  applyEngagementGating,
  persistEngagementState,
} from "../../../channels/engagement-gating.js";
import { resolveGroupSessionKey, resolveStorePath } from "../../../config/sessions.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor, resolveGroupPolicyFor } from "./group-activation.js";
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
}): { shouldProcess: boolean; mode?: "engagement" | "mention" | "always" } {
  const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
  if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
    params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
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
  const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);

  if (activationCommand.hasCommand && !owner) {
    params.logVerbose(`Ignoring /activation from non-owner in group ${params.conversationId}`);
    const sender =
      params.msg.senderName && params.msg.senderE164
        ? `${params.msg.senderName} (${params.msg.senderE164})`
        : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.groupHistories,
      historyKey: params.groupHistoryKey,
      limit: params.groupHistoryLimit,
      entry: {
        sender,
        body: params.msg.body,
        timestamp: params.msg.timestamp,
        id: params.msg.id,
        senderJid: params.msg.senderJid,
      },
    });
    return { shouldProcess: false };
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
  const activation = resolveGroupActivationFor({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
  });

  // Handle engagement mode separately
  if (activation === "engagement") {
    const groupId = resolveGroupSessionKey({
      From: params.conversationId,
      ChatType: "group",
      Provider: "whatsapp",
    })?.id;
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });

    const selfJid = params.msg.selfJid?.replace(/:\\d+/, "");
    const replySenderJid = params.msg.replyToSenderJid?.replace(/:\\d+/, "");
    const selfE164 = params.msg.selfE164 ? normalizeE164(params.msg.selfE164) : null;
    const replySenderE164 = params.msg.replyToSenderE164
      ? normalizeE164(params.msg.replyToSenderE164)
      : null;
    const implicitMention = Boolean(
      (selfJid && replySenderJid && selfJid === replySenderJid) ||
      (selfE164 && replySenderE164 && selfE164 === replySenderE164),
    );
    const effectiveMentioned = wasMentioned || implicitMention || shouldBypassMention;

    params.logVerbose(
      `[engagement] group=${groupId ?? params.conversationId} mode=engagement msg="${params.msg.body.slice(0, 50)}" mentioned=${effectiveMentioned}`,
    );

    const engagementResult = applyEngagementGating({
      cfg: params.cfg,
      channel: "whatsapp",
      groupId: groupId ?? params.conversationId,
      sessionKey: params.sessionKey,
      storePath,
      messageText: params.msg.body,
      wasMentioned: effectiveMentioned,
    });

    params.logVerbose(
      `[engagement] result: shouldProcess=${engagementResult.shouldProcess} triggered=${engagementResult.engagementTriggered} mode=${engagementResult.mode}`,
    );

    params.msg.wasMentioned = effectiveMentioned && engagementResult.shouldProcess;

    if (!engagementResult.shouldProcess) {
      params.logVerbose(
        `Group message stored for context (engagement mode, not triggered) in ${params.conversationId}: ${params.msg.body}`,
      );
      const sender =
        params.msg.senderName && params.msg.senderE164
          ? `${params.msg.senderName} (${params.msg.senderE164})`
          : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.groupHistories,
        historyKey: params.groupHistoryKey,
        limit: params.groupHistoryLimit,
        entry: {
          sender,
          body: params.msg.body,
          timestamp: params.msg.timestamp,
          id: params.msg.id,
          senderJid: params.msg.senderJid,
        },
      });
      // Still persist state update even if we don't respond
      if (engagementResult.nextState) {
        persistEngagementState({
          storePath,
          sessionKey: params.sessionKey,
          state: engagementResult.nextState,
        }).catch(() => {
          // Ignore persistence errors for non-responses
        });
      }
      return { shouldProcess: false };
    }

    // Persist engagement state for responses
    if (engagementResult.nextState) {
      persistEngagementState({
        storePath,
        sessionKey: params.sessionKey,
        state: engagementResult.nextState,
      }).catch((err) => {
        params.logVerbose(`Failed to persist engagement state: ${String(err)}`);
      });
    }

    params.replyLogger.debug(
      {
        conversationId: params.conversationId,
        mode: "engagement",
        triggered: engagementResult.engagementTriggered,
        wasMentioned: effectiveMentioned,
      },
      "engagement mode triggered",
    );

    // Return mode so caller can suppress history clearing for engagement
    return { shouldProcess: true, mode: "engagement" };
  }

  // Standard mention/always mode handling
  const requireMention = activation !== "always";
  const selfJid = params.msg.selfJid?.replace(/:\\d+/, "");
  const replySenderJid = params.msg.replyToSenderJid?.replace(/:\\d+/, "");
  const selfE164 = params.msg.selfE164 ? normalizeE164(params.msg.selfE164) : null;
  const replySenderE164 = params.msg.replyToSenderE164
    ? normalizeE164(params.msg.replyToSenderE164)
    : null;
  const implicitMention = Boolean(
    (selfJid && replySenderJid && selfJid === replySenderJid) ||
    (selfE164 && replySenderE164 && selfE164 === replySenderE164),
  );
  const mentionGate = resolveMentionGating({
    requireMention,
    canDetectMention: true,
    wasMentioned,
    implicitMention,
    shouldBypassMention,
  });
  params.msg.wasMentioned = mentionGate.effectiveWasMentioned;
  if (!shouldBypassMention && requireMention && mentionGate.shouldSkip) {
    params.logVerbose(
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
    const sender =
      params.msg.senderName && params.msg.senderE164
        ? `${params.msg.senderName} (${params.msg.senderE164})`
        : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.groupHistories,
      historyKey: params.groupHistoryKey,
      limit: params.groupHistoryLimit,
      entry: {
        sender,
        body: params.msg.body,
        timestamp: params.msg.timestamp,
        id: params.msg.id,
        senderJid: params.msg.senderJid,
      },
    });
    return { shouldProcess: false };
  }

  return { shouldProcess: true };
}
