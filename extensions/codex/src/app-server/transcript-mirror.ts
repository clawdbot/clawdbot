import { createHash } from "node:crypto";
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

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;

/**
 * Tag a message with a stable logical identity for mirror dedupe. Callers
 * should use a value that is invariant for the same logical message across
 * re-emits (e.g. `${turnId}:prompt`, `${turnId}:assistant`) but distinct
 * for genuinely-distinct messages (different turns, different kinds). When
 * present this identity replaces the role/content fingerprint in the
 * idempotency key, so the dedupe survives caller-scope rotation without
 * collapsing distinct same-content turns.
 */
export function attachCodexMirrorIdentity<T extends AgentMessage>(message: T, identity: string): T {
  const record = message as unknown as Record<string, unknown>;
  const existing = record.__openclaw;
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  } as unknown as T;
}

function readMirrorIdentity(message: MirroredAgentMessage): string | undefined {
  const record = message as unknown as { __openclaw?: unknown };
  const meta = record.__openclaw;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>)[MIRROR_IDENTITY_META_KEY];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// Fallback content fingerprint for callers that did not tag the message
// with a stable mirror identity. Only role and content participate; volatile
// metadata (timestamps, usage, etc.) is intentionally excluded so the
// fingerprint survives snapshot reordering inside a fixed scope. Distinct
// same-content turns are still distinguished by the caller's idempotency
// scope when callers route through this fallback.
function fingerprintMirrorMessageContent(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function buildMirrorDedupeIdentity(message: MirroredAgentMessage): string {
  const explicit = readMirrorIdentity(message);
  if (explicit) {
    return explicit;
  }
  return `${message.role}:${fingerprintMirrorMessageContent(message)}`;
}

export async function mirrorCodexAppServerTranscript(params: {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<void> {
  const messages = params.messages.filter(
    (message): message is MirroredAgentMessage =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
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
    for (const message of messages) {
      const dedupeIdentity = buildMirrorDedupeIdentity(message);
      const idempotencyKey = params.idempotencyScope
        ? `${params.idempotencyScope}:${dedupeIdentity}`
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
