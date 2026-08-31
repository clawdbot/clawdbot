// Bridges ACP transcript events into persisted OpenClaw session transcripts.
import { resolveAcpSessionCwd } from "@openclaw/acp-core/runtime/session-identifiers";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { persistAcpTurnTranscript } from "../../agents/command/attempt-execution.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { ReplyDispatchAssistantTranscript } from "../get-reply-options.types.js";

export async function persistAcpDispatchTranscript(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  expectedSessionId?: string;
  promptText: string;
  finalText: string;
  meta?: SessionAcpMeta;
  threadId?: string | number;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  assistantIdempotencyKey?: string;
}): Promise<ReplyDispatchAssistantTranscript | undefined> {
  const promptText = params.promptText.trim();
  const finalText = params.finalText.trim();
  if (!promptText && !finalText) {
    return undefined;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: sessionAgentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    storePath,
  });
  const sessionId = sessionEntry?.sessionId;
  if (!sessionId) {
    throw new Error(`unknown ACP session key: ${params.sessionKey}`);
  }
  if (params.expectedSessionId && sessionId !== params.expectedSessionId) {
    throw new Error("ACP transcript session changed before the turn could be persisted.");
  }

  const result = await persistAcpTurnTranscript({
    body: promptText,
    transcriptBody: promptText,
    finalText,
    sessionId,
    expectedSessionId: params.expectedSessionId,
    sessionKey: params.sessionKey,
    sessionEntry,
    storePath,
    sessionAgentId,
    threadId: params.threadId,
    sessionCwd: resolveAcpSessionCwd(params.meta) ?? process.cwd(),
    config: params.cfg,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    assistantIdempotencyKey: params.assistantIdempotencyKey,
  });
  if (result.kind === "session-rebound") {
    throw new Error("ACP transcript session changed before the turn could be persisted.");
  }
  return result.assistantTranscript && params.assistantIdempotencyKey
    ? {
        agentId: sessionAgentId,
        sessionId,
        sessionKey: params.sessionKey,
        storePath,
        messageId: result.assistantTranscript.messageId,
        anchor: result.assistantTranscript.anchor,
        idempotencyKey: params.assistantIdempotencyKey,
      }
    : undefined;
}
