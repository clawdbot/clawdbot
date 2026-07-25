import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  findConversationTurnDeliveryByReplyTarget,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  appendTranscriptEventSync,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { claimPendingConversationTurnReply } from "../../sessions/conversation-turns.js";
import {
  buildPersistedUserTurnMessage,
  preparePersistedUserTurnMessageForTranscriptWrite,
  type UserTurnInput,
} from "../../sessions/user-turn-transcript.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";

const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
const CONVERSATION_TURN_REPLY_CUSTOM_TYPE = "openclaw.conversation-turn-reply";

function readPersistedReplyText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return normalizeOptionalString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return normalizeOptionalString(
    content
      .flatMap((part) => {
        if (!part || typeof part !== "object") {
          return [];
        }
        const record = part as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
      })
      .join("\n"),
  );
}

function normalizeTimestamp(value: unknown): number | undefined {
  const timestamp = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  return asDateTimestampMs(
    timestamp < EPOCH_MILLISECONDS_THRESHOLD ? Math.trunc(timestamp * 1_000) : timestamp,
  );
}

async function capturePendingConversationTurnReplyUnsafe(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
}): Promise<boolean> {
  // Only channel owners can attest ingress admission. Raw/plugin-constructed
  // contexts without this proof must follow ordinary dispatch and its guards.
  if (params.ctx.InboundAccessAuthorized !== true) {
    return false;
  }
  const sessionKey = normalizeOptionalString(params.ctx.SessionKey);
  const messageId =
    normalizeOptionalString(params.ctx.MessageSidFull) ??
    normalizeOptionalString(params.ctx.MessageSid) ??
    normalizeOptionalString(params.ctx.MessageSidFirst) ??
    normalizeOptionalString(params.ctx.MessageSidLast);
  const replyText = normalizeOptionalString(params.ctx.agentText);
  if (!sessionKey || !messageId || !replyText) {
    return false;
  }
  const conversation = conversationIdentityFromMsgContext({ ctx: params.ctx });
  if (!conversation) {
    return false;
  }
  const replyToId =
    normalizeOptionalString(params.ctx.ReplyToIdFull) ??
    normalizeOptionalString(params.ctx.ReplyToId);
  const threadId =
    params.ctx.MessageThreadId == null
      ? undefined
      : normalizeOptionalString(String(params.ctx.MessageThreadId));
  const agentId =
    normalizeOptionalString(params.ctx.AgentId) ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const sessionEntry = loadSessionEntryReadOnly({
    agentId,
    sessionKey,
    storePath,
    readConsistency: "latest",
  });
  if (!sessionEntry) {
    return false;
  }
  const timestamp = normalizeTimestamp(params.ctx.Timestamp);
  const parentConversationRef = threadId
    ? (conversation.parentConversationRef ??
      buildConversationRef({
        channel: conversation.channel,
        accountId: conversation.accountId,
        kind: conversation.kind,
        peerId: conversation.peerId,
      }))
    : undefined;
  const input: UserTurnInput = {
    // This is the model-facing reply returned by the tool, so its durable copy
    // must pass through the same write hook and redaction policy as transcripts.
    text: replyText,
    timestamp,
    idempotencyKey: `conversation-inbound:${conversation.conversationRef}:${messageId}`,
    ...(params.ctx.InputProvenance ? { provenance: params.ctx.InputProvenance } : {}),
    transport: {
      channel: conversation.channel,
      conversationRef: conversation.conversationRef,
      messageId,
      ...(replyToId ? { replyToId } : {}),
      ...(threadId ? { threadId } : {}),
    },
    sender:
      conversation.kind === "group" || conversation.kind === "channel"
        ? {
            id: normalizeOptionalString(params.ctx.SenderId),
            name: normalizeOptionalString(params.ctx.SenderName),
            username: normalizeOptionalString(params.ctx.SenderUsername),
          }
        : undefined,
  };
  const claim = await claimPendingConversationTurnReply({
    agentId,
    conversationRef: conversation.conversationRef,
    ...(parentConversationRef ? { parentConversationRef } : {}),
    sessionId: sessionEntry.sessionId,
    messageId,
    replyToId,
    threadId,
    text: replyText,
    timestamp,
  });
  if (!claim) {
    if (replyToId) {
      const operation =
        findConversationTurnDeliveryByReplyTarget(
          { agentId, storePath },
          { conversationRef: conversation.conversationRef, replyToId },
        ) ??
        (parentConversationRef && parentConversationRef !== conversation.conversationRef
          ? findConversationTurnDeliveryByReplyTarget(
              { agentId, storePath },
              { conversationRef: parentConversationRef, replyToId },
            )
          : undefined);
      if (operation?.status === "replied" && operation.reply?.messageId === messageId) {
        // A transport retry of the already-captured message remains consumed;
        // starting an ordinary turn would surface the same peer reply twice.
        return true;
      }
      if (operation && operation.status !== "replied") {
        // With no process-local waiter, ordinary inbound dispatch owns this
        // reply. It proves the outbound send, but must not become replayable as
        // an inline tool result on a later stable turn retry.
        markConversationDeliverySent({ agentId, storePath }, operation.operationId, replyToId);
      }
    }
    return false;
  }
  try {
    if (sessionEntry.sessionId !== claim.sessionId) {
      throw new Error(`session changed before captured reply persistence: ${sessionKey}`);
    }
    const prepared = preparePersistedUserTurnMessageForTranscriptWrite(
      buildPersistedUserTurnMessage(input),
      {
        agentId,
        sessionKey,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      },
    );
    if (!prepared) {
      throw new Error("captured conversation turn reply was blocked before persistence");
    }
    const persistedMessage = redactTranscriptMessage(prepared, params.cfg);
    const persistedReplyText = readPersistedReplyText(persistedMessage);
    if (!persistedReplyText) {
      throw new Error("captured conversation turn reply has no persistable text");
    }
    const artifactId = `conversation-turn-reply-${claim.turnId}`;
    // Commit the replayable owner state before its optional audit artifact. A
    // crash after this point can lose audit metadata, but never the claimed reply.
    markConversationDeliveryReplied(
      { agentId, storePath },
      {
        operationId: claim.turnId,
        reply: {
          messageId,
          ...(replyToId ? { replyToId } : {}),
          ...(threadId ? { threadId } : {}),
          text: persistedReplyText,
          timestamp: timestamp ?? Date.now(),
        },
      },
    );
    // The tool result owns model context. A side artifact keeps an audit trail
    // without inserting a user row between an active tool call and its result.
    let persisted = false;
    try {
      persisted = appendTranscriptEventSync(
        { agentId, sessionId: sessionEntry.sessionId, sessionKey, storePath },
        {
          type: "custom",
          id: artifactId,
          customType: CONVERSATION_TURN_REPLY_CUSTOM_TYPE,
          appendMode: "side",
          timestamp: timestamp ?? Date.now(),
          data: {
            turnId: claim.turnId,
            conversationRef: conversation.conversationRef,
            messageId,
            ...(replyToId ? { replyToId } : {}),
            ...(threadId ? { threadId } : {}),
            message: persistedMessage,
          },
        },
      );
    } catch (error) {
      logVerbose(`captured conversation turn reply audit persistence failed: ${String(error)}`);
    }
    if (!persisted) {
      logVerbose("captured conversation turn reply audit artifact was not persisted");
    }
    claim.complete(persisted ? { transcriptArtifactId: artifactId } : undefined);
    return true;
  } catch (error) {
    claim.release();
    logVerbose(`conversation turn reply capture failed: ${String(error)}`);
    return false;
  }
}

/** Consumes a correlated channel reply before it can start a second local agent turn. */
export async function capturePendingConversationTurnReply(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
}): Promise<boolean> {
  try {
    return await capturePendingConversationTurnReplyUnsafe(params);
  } catch (error) {
    // Correlation is an optional interception path. Storage/config failures must
    // fall through to ordinary inbound dispatch and its existing lifecycle cleanup.
    logVerbose(`conversation turn reply capture unavailable: ${String(error)}`);
    return false;
  }
}
