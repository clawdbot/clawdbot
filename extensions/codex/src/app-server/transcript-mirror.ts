import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  acquireSessionWriteLock,
  emitSessionTranscriptUpdate,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export async function mirrorCodexAppServerTranscript(params: {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
}): Promise<void> {
  const messages = params.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (messages.length === 0) {
    return;
  }

  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: 10_000,
  });
  try {
    const existingIdempotencyKeys = await readTranscriptIdempotencyKeys(params.sessionFile);
    const sessionManager = SessionManager.open(params.sessionFile);
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
      } as Parameters<SessionManager["appendMessage"]>[0];
      const nextMessage = runAgentHarnessBeforeMessageWriteHook({
        message: transcriptMessage,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      if (!nextMessage) {
        continue;
      }
      const messageToAppend = (idempotencyKey
        ? {
            ...(nextMessage as unknown as Record<string, unknown>),
            idempotencyKey,
          }
        : nextMessage) as unknown as Parameters<SessionManager["appendMessage"]>[0];
      sessionManager.appendMessage(messageToAppend);
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
