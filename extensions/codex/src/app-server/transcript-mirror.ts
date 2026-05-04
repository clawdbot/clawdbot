import fs from "node:fs/promises";
import {
  acquireSessionWriteLock,
  appendSessionTranscriptMessage,
  emitSessionTranscriptUpdate,
  resolveSessionWriteLockAcquireTimeoutMs,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
  type SessionWriteLockAcquireTimeoutConfig,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export async function mirrorCodexAppServerTranscript(params: {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<void> {
  const messages = params.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (messages.length === 0) {
    return;
  }

  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
  });
  try {
    const existingIdempotencyKeys = await readTranscriptIdempotencyKeys(params.sessionFile);
    for (const [index, message] of messages.entries()) {
      const idempotencyKey = params.idempotencyScope
        ? `${params.idempotencyScope}:${message.role}:${index}`
        : undefined;
      if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
        continue;
      }
      const transcriptMessage = {
        ...message,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as AgentMessage;
      const nextMessage = runAgentHarnessBeforeMessageWriteHook({
        message: transcriptMessage,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      if (!nextMessage) {
        continue;
      }
      const messageToAppend = (
        idempotencyKey
          ? {
              ...(nextMessage as unknown as Record<string, unknown>),
              idempotencyKey,
            }
          : nextMessage
      ) as AgentMessage;
      await appendSessionTranscriptMessage({
        transcriptPath: params.sessionFile,
        message: messageToAppend,
        config: params.config,
      });
      if (idempotencyKey) {
        existingIdempotencyKeys.add(idempotencyKey);
      }
    }
  } finally {
    await lock.release();
  }

  if (params.sessionKey) {
    emitSessionTranscriptUpdate({ sessionFile: params.sessionFile, sessionKey: params.sessionKey });
  } else {
    emitSessionTranscriptUpdate(params.sessionFile);
  }
}

async function readTranscriptIdempotencyKeys(sessionFile: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return keys;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (typeof parsed.message?.idempotencyKey === "string") {
        keys.add(parsed.message.idempotencyKey);
      }
    } catch {
      continue;
    }
  }
  return keys;
}
