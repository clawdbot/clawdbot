// Chat gateway methods expose the stable registry while focused modules own large workflows.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatInjectParams,
  validateChatToolTitlesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { sendGlobalAwareNodeChatPayload } from "./chat-broadcast.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat-origin-routing.js";
import { handleChatSend } from "./chat-send-handler.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import type { GatewayRequestHandlers } from "./types.js";

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
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  "chat.toolTitles": async ({ params, respond, context }) => {
    if (!validateChatToolTitlesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.toolTitles params: ${formatValidationErrors(validateChatToolTitlesParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    // Opt-in gate: tool titles spend utility-model tokens, so the gateway
    // stays fully deterministic unless the operator enables them explicitly.
    // `disabled: true` lets clients stop asking for the rest of the session.
    if (cfg.gateway?.controlUi?.toolTitles !== true) {
      respond(true, { titles: {}, disabled: true });
      return;
    }
    const agentIdOverride = normalizeOptionalText(params.agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg,
      requestedSessionKey: params.sessionKey,
      agentId: agentIdOverride,
    });
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: params.sessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    try {
      const sessionAgentId = resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
        agentId: selectedAgent.agentId,
      });
      // Session entry carries per-session model overrides; utility routing must
      // derive its small-model default from the provider this session actually
      // uses, not the agent's configured default.
      const { cfg: sessionCfg, entry } = loadSessionEntry(
        params.sessionKey,
        selectedAgent.agentId ? { agentId: selectedAgent.agentId } : undefined,
      );
      const sessionModel = resolveSessionModelRef(sessionCfg, entry, sessionAgentId);
      // Title generation pulls in the simple-completion runtime; load it lazily
      // so gateways that never enable the opt-in skip that cost.
      const { generateToolCallTitles } = await import("../chat-tool-titles.js");
      const titles = await generateToolCallTitles({
        cfg: sessionCfg,
        agentId: sessionAgentId,
        sessionPrimaryProvider: sessionModel.provider,
        sessionAuthProfile: entry?.authProfileOverride?.trim() || undefined,
        items: params.items,
      });
      respond(true, { titles });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "chat.abort": handleChatAbortRequest,
  "chat.send": handleChatSend,
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
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
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: p.agentId,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const {
      cfg,
      storePath,
      entry,
      canonicalKey: sessionKey,
    } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
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
              sessionFile: entry.sessionFile,
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
      ...(sessionKey === "global" && agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload, {
      sessionKeys: sessionKey === "global" && agentId ? [`agent:${agentId}:global`] : [sessionKey],
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
