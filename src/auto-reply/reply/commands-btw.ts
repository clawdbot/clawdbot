/** Handles /btw side-question commands against the active session context. */
import { randomUUID } from "node:crypto";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { runBtwSideQuestion } from "../../agents/btw.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { extractBtwQuestion } from "./btw-command.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const BTW_USAGE = "Usage: /btw [side question]";

/** Command handler for /btw side questions. */
export const handleBtwCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const question = extractBtwQuestion(params.command.commandBodyNormalized);
  if (question === null) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/btw");
  if (unauthorized) {
    return unauthorized;
  }

  if (!question) {
    return {
      shouldContinue: false,
      reply: { text: BTW_USAGE },
    };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /btw requires an active session with existing context." },
    };
  }

  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : params.agentId;
  const agentDir =
    (sessionAgentId ? resolveAgentDir(params.cfg, sessionAgentId) : undefined) ?? params.agentDir;

  if (!agentDir) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /btw is unavailable because the active agent directory could not be resolved.",
      },
    };
  }

  try {
    await params.typing?.startTypingLoop();
    const messageTo =
      params.ctx.OriginatingTo?.trim() || params.command.to || params.command.channelId;
    const nativeChannelId =
      params.ctx.NativeChannelId?.trim() || params.ctx.ChatId?.trim() || undefined;
    const currentChannelId = nativeChannelId ?? messageTo;
    const chatType = normalizeChatType(params.ctx.ChatType);
    const groupId = resolveGroupSessionKey(params.ctx)?.id ?? targetSessionEntry.groupId;
    const runId = params.opts?.runId ?? `btw-${randomUUID()}`;
    const currentChannelProvider = normalizeAnyChannelId(params.ctx.Provider);
    const capabilitySessionKey = params.ctx.RuntimePolicySessionKey ?? params.sessionKey;
    const messageActionTurnCapability =
      isTrustedMessageActionTurnIngress(params.ctx.Provider) &&
      sessionAgentId &&
      capabilitySessionKey &&
      currentChannelProvider &&
      currentChannelId
        ? mintMessageActionTurnCapability({
            agentId: sessionAgentId,
            runId,
            sessionKey: capabilitySessionKey,
            sessionId: targetSessionEntry.sessionId,
            requesterAccountId: params.ctx.AccountId,
            requesterSenderId: params.ctx.SenderId ?? params.command.senderId,
            toolContext: {
              currentChannelId,
              currentChatType: chatType,
              currentMessagingTarget: messageTo,
              currentChannelProvider,
              currentMessageId: params.ctx.MessageSidFull ?? params.ctx.MessageSid,
            },
          })
        : undefined;
    let reply: Awaited<ReturnType<typeof runBtwSideQuestion>>;
    try {
      reply = await runBtwSideQuestion({
        cfg: params.cfg,
        agentDir,
        provider: params.provider,
        model: params.model,
        question,
        sessionEntry: targetSessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        ...(params.ctx.RuntimePolicySessionKey
          ? { sandboxSessionKey: params.ctx.RuntimePolicySessionKey }
          : {}),
        storePath: params.storePath,
        // BTW is intentionally a quick side question, so do not inherit slower
        // session-level think/reasoning settings from the main run.
        resolvedThinkLevel: "off",
        resolvedReasoningLevel: "off",
        blockReplyChunking: params.blockReplyChunking,
        resolvedBlockStreamingBreak: params.resolvedBlockStreamingBreak,
        opts: { ...params.opts, runId },
        isNewSession: false,
        ...(params.command.channel ? { messageChannel: params.command.channel } : {}),
        ...(params.command.channel ? { messageProvider: params.command.channel } : {}),
        ...(chatType ? { chatType } : {}),
        ...(params.ctx.AccountId ? { agentAccountId: params.ctx.AccountId } : {}),
        ...(messageTo ? { messageTo } : {}),
        ...(params.ctx.MessageThreadId !== undefined
          ? { messageThreadId: params.ctx.MessageThreadId }
          : params.ctx.TransportThreadId !== undefined
            ? { messageThreadId: params.ctx.TransportThreadId }
            : {}),
        ...(nativeChannelId ? { chatId: nativeChannelId } : {}),
        ...(messageActionTurnCapability ? { messageActionTurnCapability } : {}),
        ...(groupId ? { groupId } : {}),
        ...(params.ctx.GroupChannel || params.ctx.GroupSubject || targetSessionEntry.groupChannel
          ? {
              groupChannel:
                params.ctx.GroupChannel ??
                params.ctx.GroupSubject ??
                targetSessionEntry.groupChannel,
            }
          : {}),
        ...(params.ctx.GroupSpace || targetSessionEntry.space
          ? { groupSpace: params.ctx.GroupSpace ?? targetSessionEntry.space }
          : {}),
        ...(params.ctx.MemberRoleIds ? { memberRoleIds: params.ctx.MemberRoleIds } : {}),
        ...(targetSessionEntry.parentSessionKey
          ? { spawnedBy: targetSessionEntry.parentSessionKey }
          : {}),
        ...(params.ctx.SenderId || params.command.senderId
          ? { senderId: params.ctx.SenderId ?? params.command.senderId }
          : {}),
        ...(params.ctx.SenderName ? { senderName: params.ctx.SenderName } : {}),
        ...(params.ctx.SenderUsername ? { senderUsername: params.ctx.SenderUsername } : {}),
        ...(params.ctx.SenderE164 ? { senderE164: params.ctx.SenderE164 } : {}),
        senderIsOwner: params.command.senderIsOwner,
        ...(currentChannelId ? { currentChannelId } : {}),
      });
    } finally {
      revokeMessageActionTurnCapability(messageActionTurnCapability);
    }
    return {
      shouldContinue: false,
      reply: reply ? { ...reply, btw: { question } } : reply,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ /btw failed${message ? `: ${message}` : "."}`,
        btw: { question },
        isError: true,
      },
    };
  }
};
