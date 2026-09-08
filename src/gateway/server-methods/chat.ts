// Chat gateway methods expose the stable registry while focused modules own large workflows.
import {
  ErrorCodes,
  errorShape,
  validateChatInjectParams,
  validateChatToolTitlesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGlobalAwareNodeChatDeliveryKeys,
  sendGlobalAwareNodeChatPayload,
} from "./chat-broadcast.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { validateChatSelectedAgent } from "./chat-origin-routing.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export {
  augmentChatHistoryWithCanvasBlocks,
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  dropPreSessionStartAnnouncePairs,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";
export { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
export {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  "chat.toolTitles": async ({ params, respond }) => {
    if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) {
      return;
    }
    // Keep the shipped disabled response until a versioned protocol removal;
    // older clients stop asking, while current clients read the tool call title.
    respond(true, { titles: {}, disabled: true });
  },
  "chat.send": handleDirectExternalChatSend,
  "chat.inject": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) {
      return;
    }
    const p = params as {
      sessionKey: string;
      agentId?: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const agentIdOverride = normalizeOptionalText(p.agentId);
    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      rawSessionKey,
      agentIdOverride,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const sessionLoadOptions = { agentId: requestedAgentId };
    const {
      cfg,
      storePath,
      entry,
      canonicalKey: sessionKey,
    } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      explicitAgentId: agentIdOverride,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });

    let appended: Awaited<ReturnType<typeof appendAssistantTranscriptMessage>>;
    try {
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {
          const latestEntry = loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;
          if (!latestEntry) {
            throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
          }
          if (latestEntry.sessionId !== sessionId) {
            throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
          }
          const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
          if (archivedError) {
            throw new Error(archivedError);
          }
        },
      });
      try {
        appended = await admission.run(
          async () =>
            await appendAssistantTranscriptMessage({
              sessionKey,
              message: p.message,
              label: p.label,
              sessionId,
              storePath,
              agentId,
              createIfMissing: true,
              cfg,
            }),
        );
      } finally {
        admission.release();
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload, {
      sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({ cfg, sessionKey, agentId }),
    });
    sendGlobalAwareNodeChatPayload({
      context,
      sessionKey,
      agentId,
      event: "chat",
      payload: chatPayload,
    });

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
