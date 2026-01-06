import { randomUUID } from "node:crypto";

import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { agentCommand } from "../../commands/agent.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { buildMessageWithAttachments } from "../chat-attachments.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { MAX_CHAT_HISTORY_MESSAGES_BYTES } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath) : [];
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced =
      rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const capped = capArrayByJsonBytes(
      sliced,
      MAX_CHAT_HISTORY_MESSAGES_BYTES,
    ).items;
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const configured = cfg.agent?.thinkingDefault;
      if (configured) {
        thinkingLevel = configured;
      } else {
        const { provider, model } = resolveSessionModelRef(cfg, entry);
        const catalog = await context.loadGatewayModelCatalog();
        thinkingLevel = resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog,
        });
      }
    }
    respond(true, {
      sessionKey,
      sessionId,
      messages: capped,
      thinkingLevel,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, runId } = params as {
      sessionKey: string;
      runId: string;
    };
    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false });
      return;
    }
    if (active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "runId does not match sessionKey",
        ),
      );
      return;
    }

    active.controller.abort();
    context.chatAbortControllers.delete(runId);
    context.chatRunBuffers.delete(runId);
    context.chatDeltaSentAt.delete(runId);
    context.removeChatRun(runId, runId, sessionKey);

    const payload = {
      runId,
      sessionKey,
      seq: (context.agentRunSeq.get(runId) ?? 0) + 1,
      state: "aborted" as const,
    };
    context.broadcast("chat", payload);
    context.bridgeSendToSession(sessionKey, "chat", payload);
    respond(true, { ok: true, aborted: true });
  },
  "chat.send": async ({ params, respond, context }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const normalizedAttachments =
      p.attachments?.map((a) => ({
        type: typeof a?.type === "string" ? a.type : undefined,
        mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
        fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
        content:
          typeof a?.content === "string"
            ? a.content
            : ArrayBuffer.isView(a?.content)
              ? Buffer.from(
                  a.content.buffer,
                  a.content.byteOffset,
                  a.content.byteLength,
                ).toString("base64")
              : undefined,
      })) ?? [];
    let messageWithAttachments = p.message;
    if (normalizedAttachments.length > 0) {
      try {
        messageWithAttachments = buildMessageWithAttachments(
          p.message,
          normalizedAttachments,
          { maxBytes: 5_000_000 },
        );
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, String(err)),
        );
        return;
      }
    }
    const { cfg, storePath, store, entry } = loadSessionEntry(p.sessionKey);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const sessionId = entry?.sessionId ?? randomUUID();
    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: now,
      thinkingLevel: entry?.thinkingLevel,
      verboseLevel: entry?.verboseLevel,
      systemSent: entry?.systemSent,
      sendPolicy: entry?.sendPolicy,
      lastChannel: entry?.lastChannel,
      lastTo: entry?.lastTo,
    };
    const clientRunId = p.idempotencyKey;
    registerAgentRunContext(clientRunId, { sessionKey: p.sessionKey });

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey: p.sessionKey,
      surface: entry?.surface,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "send blocked by session policy",
        ),
      );
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId,
        sessionKey: p.sessionKey,
      });
      context.addChatRun(clientRunId, {
        sessionKey: p.sessionKey,
        clientRunId,
      });

      if (store) {
        store[p.sessionKey] = sessionEntry;
        if (storePath) {
          await saveSessionStore(storePath, store);
        }
      }

      await agentCommand(
        {
          message: messageWithAttachments,
          sessionId,
          runId: clientRunId,
          thinking: p.thinking,
          deliver: p.deliver,
          timeout: Math.ceil(timeoutMs / 1000).toString(),
          surface: "WebChat",
          abortSignal: abortController.signal,
        },
        defaultRuntime,
        context.deps,
      );
      const payload = {
        runId: clientRunId,
        status: "ok" as const,
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: true,
        payload,
      });
      respond(true, payload, undefined, { runId: clientRunId });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    } finally {
      context.chatAbortControllers.delete(clientRunId);
    }
  },
};
