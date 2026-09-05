// Single-message lookup applies the same visibility and display projection as chat.history.
import {
  ErrorCodes,
  errorShape,
  validateChatMessageGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readSessionPendingInput } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessage,
} from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "../session-transcript-anchor-reader.js";
import { readSessionMessageByIdAsync } from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { readChatHistoryMessageId } from "./chat-history-pages.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import { projectPendingInputMessage } from "./chat-pending-inputs.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

async function isChatMessageIdVisibleAfterHistoryFilters(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionEntry?: { sessionFile?: string; sessionId?: string };
  sessionKey: string;
  agentId?: string;
  messageId: string;
  sessionStartedAt?: number;
  allowResetArchiveFallback?: boolean;
}): Promise<boolean> {
  if (params.sessionStartedAt === undefined) {
    return true;
  }
  // The anchored reader includes the immediately preceding row, which is the
  // complete context needed to hide a stale announce and its paired reply.
  const { messages } = await readSessionMessagesAroundIdWithStatsAsync(
    {
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      maxMessages: 1,
      messageId: params.messageId,
      ...(params.allowResetArchiveFallback === true ? { allowResetArchiveFallback: true } : {}),
    },
  );
  return dropPreSessionStartAnnouncePairs(messages, params.sessionStartedAt).some(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
}

export const chatMessageGetHandlers: GatewayRequestHandlers = {
  "chat.message.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateChatMessageGetParams, "chat.message.get", respond)) {
      return;
    }
    const { sessionKey, messageId, maxChars } = params as {
      sessionKey: string;
      agentId?: string;
      messageId: string;
      maxChars?: number;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const requestedAgent = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: sessionKey,
      agentId: agentIdOverride,
    });
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const { cfg, storePath, entry, canonicalKey } = loadGatewaySessionEntryReadOnly(
      sessionKey,
      sessionLoadOptions,
    );
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: sessionKey,
      explicitAgentId: agentIdOverride,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }

    const sessionAgentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });
    const effectiveMaxChars =
      typeof maxChars === "number" ? maxChars : Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
    if (messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
      // Pending IDs have their own owner. A transcript miss must never widen
      // into pending custody or an archived physical session.
      const pending = readSessionPendingInput(
        {
          agentId: sessionAgentId,
          sessionKey: canonicalKey,
          sessionId,
          storePath,
        },
        messageId.slice(CHAT_PENDING_INPUT_MESSAGE_PREFIX.length),
      );
      if (!pending) {
        respond(true, { ok: false, unavailableReason: "not_found" });
        return;
      }
      const message = projectPendingInputMessage(pending, effectiveMaxChars);
      if (!message) {
        respond(true, { ok: false, unavailableReason: "not_visible" });
        return;
      }
      respond(
        true,
        jsonUtf8Bytes(message) > MAX_PAYLOAD_BYTES - 1024
          ? { ok: false, unavailableReason: "oversized" }
          : { ok: true, message },
      );
      return;
    }
    const resolved = await readSessionMessageByIdAsync(
      {
        agentId: sessionAgentId,
        sessionEntry: entry,
        sessionId,
        sessionKey,
        storePath,
      },
      messageId,
      { allowResetArchiveFallback: true },
    );
    if (!resolved.found) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    const visible = await isChatMessageIdVisibleAfterHistoryFilters({
      sessionId,
      storePath,
      sessionEntry: entry,
      sessionKey,
      agentId: sessionAgentId,
      messageId,
      sessionStartedAt:
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
      allowResetArchiveFallback: true,
    });
    if (!visible) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    if (resolved.oversized) {
      respond(true, { ok: false, unavailableReason: "oversized" });
      return;
    }

    const projectedMessage = resolved.message
      ? projectChatDisplayMessage(resolved.message, {
          maxChars: effectiveMaxChars,
          resolveCurrentUserProfileDisplay,
        })
      : undefined;
    const projected = projectedMessage
      ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0]
      : undefined;
    if (!projected) {
      respond(true, { ok: false, unavailableReason: "not_visible" });
      return;
    }

    respond(true, {
      ok: true,
      message: projected,
    });
  },
};
