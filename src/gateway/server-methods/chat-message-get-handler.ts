// Single-message lookup applies the same visibility and display projection as chat.history.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatMessageGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessage,
} from "../chat-display-projection.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessagesAsync,
} from "../session-transcript-readers.js";
import { loadSessionEntry } from "../session-utils.js";
import { readChatHistoryMessageId } from "./chat-history-pages.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlers } from "./types.js";

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
  const messages = await readSessionMessagesAsync(
    {
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      mode: "full",
      reason: "chat.message.get visibility",
      ...(params.allowResetArchiveFallback === true ? { allowResetArchiveFallback: true } : {}),
    },
  );
  return dropPreSessionStartAnnouncePairs(messages, params.sessionStartedAt).some(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
}

export const chatMessageGetHandlers: GatewayRequestHandlers = {
  "chat.message.get": async ({ params, respond, context }) => {
    if (!validateChatMessageGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.message.get params: ${formatValidationErrors(validateChatMessageGetParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, messageId, maxChars } = params as {
      sessionKey: string;
      agentId?: string;
      messageId: string;
      maxChars?: number;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: sessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: sessionKey,
      agentId: requestedAgentId,
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

    const effectiveMaxChars =
      typeof maxChars === "number" ? maxChars : Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
    const projectedMessage = resolved.message
      ? projectChatDisplayMessage(resolved.message, {
          maxChars: effectiveMaxChars,
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
