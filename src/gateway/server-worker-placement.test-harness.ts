import { vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";

export function createWorkerStopChatContext() {
  return createChatAbortContext() as unknown as GatewayRequestContext;
}

export function admitWorkerStopChat(params: {
  context: GatewayRequestContext;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  entry: SessionEntry;
  runId: string;
}) {
  const { context, storePath, sessionKey, sessionId, agentId, entry, runId } = params;
  const respond = vi.fn();
  const now = Date.now();
  const promise = admitChatSend({
    request: {
      p: { sessionKey, message: "continue", idempotencyKey: runId },
      chatSendReceivedAtMs: now,
      supportsTaskSuggestions: false,
      inboundMessage: "continue",
      rawMessage: "continue",
      suppressCommandInterpretation: false,
      stopCommand: false,
      turnKind: "main",
      normalizedAttachments: [],
      reconnectResumeRequested: false,
    },
    session: {
      rawSessionKey: sessionKey,
      sessionLoadKey: sessionKey,
      clientRunId: runId,
      pendingChatSendKey: pendingChatSendDedupeKey(runId),
      sessionLoadOptions: { agentId },
      sessionLoadMs: 0,
      cfg: {},
      storePath,
      entry,
      sessionKey,
      legacyKey: undefined,
      expectedLeafEntryId: undefined,
      sessionRoutingChanged: () => false,
      agentIdOverride: agentId,
      requestedAgentId: agentId,
      selectedAgent: { ok: true, agentId },
      requestedSessionId: undefined,
      backingSessionId: sessionId,
      agentId,
      resolvedSessionModel: { provider: "openai", model: "gpt-5.6-luna" },
      resolvedSessionAuthProvider: "openai",
      activeRunScopeKey: sessionKey,
      timeoutMs: 600000,
      now,
      restartSafeRequest: undefined,
    },
    context,
    client: null,
    respond,
  });
  return { promise, respond };
}
