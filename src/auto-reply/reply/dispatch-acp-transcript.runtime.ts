// Bridges ACP transcript events into persisted OpenClaw session transcripts.
import { resolveAcpSessionCwd } from "@openclaw/acp-core/runtime/session-identifiers";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { persistAcpTurnTranscript } from "../../agents/command/attempt-execution.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";

export async function persistAcpDispatchTranscript(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  promptText: string;
  finalText: string;
  meta?: SessionAcpMeta;
  runId?: string;
  threadId?: string | number;
}): Promise<void> {
  const promptText = params.promptText.trim();
  const finalText = params.finalText.trim();
  if (!promptText && !finalText) {
    return;
  }
  const runId = params.runId?.trim();

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

  await persistAcpTurnTranscript({
    body: promptText,
    transcriptBody: promptText,
    ...(runId && promptText
      ? {
          userInput: {
            text: promptText,
            idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
          },
        }
      : {}),
    finalText,
    ...(runId ? { assistantIdempotencyKey: runId } : {}),
    sessionId,
    sessionKey: params.sessionKey,
    sessionEntry,
    storePath,
    sessionAgentId,
    threadId: params.threadId,
    sessionCwd: resolveAcpSessionCwd(params.meta) ?? process.cwd(),
    config: params.cfg,
  });
}
