import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  acquireSessionWriteLock,
  appendSessionTranscriptMessage,
  embeddedAgentLog,
  emitSessionTranscriptUpdate,
  formatErrorMessage,
  resolveSessionWriteLockOptions,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type SessionWriteLockAcquireTimeoutConfig,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;

export type CodexAppServerTranscriptMirrorResult = {
  userMessagesPresent: MirroredUserMessage[];
};

const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;

function buildSenderLabel(params: {
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
}): string | undefined {
  const label = params.senderName ?? params.senderUsername ?? params.senderE164 ?? params.senderId;
  if (!label) {
    return undefined;
  }
  if (!params.senderId || label.includes(params.senderId)) {
    return label;
  }
  return `${label} (${params.senderId})`;
}

function buildCodexUserPromptMessageFromPrepared(
  params: EmbeddedRunAttemptParams,
  preparedUserMessage: MirroredUserMessage | undefined,
): AgentMessage {
  const senderId = normalizeOptionalString(params.senderId);
  const senderName = normalizeOptionalString(params.senderName);
  const senderUsername = normalizeOptionalString(params.senderUsername);
  const senderE164 = normalizeOptionalString(params.senderE164);
  const senderLabel = buildSenderLabel({ senderId, senderName, senderUsername, senderE164 });
  const sourceChannel = normalizeOptionalString(
    params.inputProvenance?.sourceChannel ?? params.messageChannel ?? params.messageProvider,
  );
  if (preparedUserMessage) {
    return {
      role: "user",
      timestamp: Date.now(),
      ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
      ...(sourceChannel ? { sourceChannel } : {}),
      ...(senderId ? { senderId } : {}),
      ...(senderName ? { senderName } : {}),
      ...(senderUsername ? { senderUsername } : {}),
      ...(senderE164 ? { senderE164 } : {}),
      ...(senderLabel ? { senderLabel } : {}),
      ...(preparedUserMessage as unknown as Record<string, unknown>),
    } as AgentMessage;
  }
  return {
    role: "user",
    content: params.prompt,
    timestamp: Date.now(),
    ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(senderE164 ? { senderE164 } : {}),
    ...(senderLabel ? { senderLabel } : {}),
  } as AgentMessage;
}

export function buildCodexUserPromptMessage(params: EmbeddedRunAttemptParams): AgentMessage {
  return buildCodexUserPromptMessageFromPrepared(
    params,
    params.userTurnTranscriptRecorder?.message,
  );
}

export async function buildResolvedCodexUserPromptMessage(
  params: EmbeddedRunAttemptParams,
): Promise<AgentMessage> {
  const resolvedMessage = await params.userTurnTranscriptRecorder?.resolveMessage();
  return buildCodexUserPromptMessageFromPrepared(
    params,
    resolvedMessage ?? params.userTurnTranscriptRecorder?.message,
  );
}

export async function mirrorTranscriptBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: (message: Extract<AgentMessage, { role: "user" }>) => void;
  result: EmbeddedRunAttemptResult;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<void> {
  try {
    const messages = await resolveFinalCodexMirrorMessages({
      params: params.params,
      messagesSnapshot: params.result.messagesSnapshot,
      turnId: params.turnId,
    });
    const mirrorResult = await mirrorCodexAppServerTranscript({
      sessionFile: params.params.sessionFile,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      cwd: params.cwd,
      messages,
      // Scope is thread-stable. Each entry in `messagesSnapshot` is tagged
      // with a per-turn `attachCodexMirrorIdentity` value carrying its own
      // turnId, so distinct turns produce distinct dedupe keys via the
      // identity (not via the scope). Dropping `turnId` from the scope here is
      // what lets a re-emitted prior-turn entry collide with its existing key.
      idempotencyScope: `codex-app-server:${params.threadId}`,
      config: params.params.config,
    });
    for (const message of mirrorResult.userMessagesPresent) {
      params.notifyUserMessagePersisted(message);
    }
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", { error });
  }
}

export async function resolveFinalCodexMirrorMessages(params: {
  params: EmbeddedRunAttemptParams;
  messagesSnapshot: AgentMessage[];
  turnId: string;
}): Promise<AgentMessage[]> {
  if (
    params.params.suppressNextUserMessagePersistence ||
    !params.params.userTurnTranscriptRecorder
  ) {
    return params.messagesSnapshot;
  }
  const resolvedPrompt = attachCodexMirrorIdentity(
    await buildResolvedCodexUserPromptMessage(params.params),
    `${params.turnId}:prompt`,
  );
  const firstUserIndex = params.messagesSnapshot.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) {
    return [resolvedPrompt, ...params.messagesSnapshot];
  }
  const messages = params.messagesSnapshot.slice();
  messages[firstUserIndex] = resolvedPrompt;
  return messages;
}

export function createCodexAppServerUserMessagePersistenceNotifier(
  runParams: EmbeddedRunAttemptParams,
): (message: Extract<AgentMessage, { role: "user" }>) => void {
  let notified = false;
  return (message) => {
    if (notified) {
      return;
    }
    notified = true;
    runParams.userTurnTranscriptRecorder?.markRuntimePersisted(message);
    try {
      runParams.onUserMessagePersisted?.(message);
    } catch (error) {
      embeddedAgentLog.warn("codex app-server user persistence notification failed", {
        error: formatErrorMessage(error),
      });
    }
  };
}

export async function mirrorPromptAtTurnStartBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: (message: Extract<AgentMessage, { role: "user" }>) => void;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<void> {
  if (params.params.suppressNextUserMessagePersistence) {
    return;
  }
  try {
    const mirrorPromise = (async () => {
      const userPromptMessage = attachCodexMirrorIdentity(
        await buildResolvedCodexUserPromptMessage(params.params),
        `${params.turnId}:prompt`,
      );
      const mirrorResult = await mirrorCodexAppServerTranscript({
        sessionFile: params.params.sessionFile,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.params.sessionId,
        cwd: params.cwd,
        messages: [userPromptMessage],
        idempotencyScope: `codex-app-server:${params.threadId}`,
        config: params.params.config,
      });
      for (const message of mirrorResult.userMessagesPresent) {
        params.notifyUserMessagePersisted(message);
      }
    })();
    params.params.userTurnTranscriptRecorder?.markRuntimePersistencePending(mirrorPromise);
    await mirrorPromise;
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server prompt at turn start", { error });
  }
}

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
  const existing = record["__openclaw"];
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
  const meta = record["__openclaw"];
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
  sessionId?: string;
  cwd?: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<CodexAppServerTranscriptMirrorResult> {
  const messages = params.messages.filter(
    (message): message is MirroredAgentMessage =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  if (messages.length === 0) {
    return { userMessagesPresent: [] };
  }

  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    ...resolveSessionWriteLockOptions(params.config),
  });
  const appendedUpdates: Array<{ messageId: string; message: AgentMessage; messageSeq: number }> =
    [];
  const userMessagesPresent: MirroredUserMessage[] = [];
  try {
    const mirrorState = await readTranscriptMirrorState(params.sessionFile);
    let nextMessageSeq = mirrorState.messageCount;
    for (const message of messages) {
      const dedupeIdentity = buildMirrorDedupeIdentity(message);
      const idempotencyKey = params.idempotencyScope
        ? `${params.idempotencyScope}:${dedupeIdentity}`
        : undefined;
      const transcriptMessage = {
        ...message,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as AgentMessage;
      if (idempotencyKey && mirrorState.idempotencyKeys.has(idempotencyKey)) {
        const persistedUserMessage = mirrorState.userMessagesByIdempotencyKey.get(idempotencyKey);
        if (persistedUserMessage) {
          userMessagesPresent.push(persistedUserMessage);
        }
        continue;
      }
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
      const { messageId, message: appendedMessage } = await appendSessionTranscriptMessage({
        transcriptPath: params.sessionFile,
        message: messageToAppend,
        idempotencyLookup: idempotencyKey ? "caller-checked" : "scan",
        sessionId: params.sessionId,
        cwd: params.cwd,
        config: params.config,
      });
      if (appendedMessage.role === "user") {
        userMessagesPresent.push(appendedMessage);
        if (idempotencyKey) {
          mirrorState.userMessagesByIdempotencyKey.set(idempotencyKey, appendedMessage);
        }
      }
      nextMessageSeq += 1;
      appendedUpdates.push({ messageId, message: appendedMessage, messageSeq: nextMessageSeq });
      if (idempotencyKey) {
        mirrorState.idempotencyKeys.add(idempotencyKey);
      }
    }
  } finally {
    await lock.release();
  }

  for (const update of appendedUpdates) {
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      message: update.message,
      messageId: update.messageId,
      messageSeq: update.messageSeq,
    });
  }

  return { userMessagesPresent };
}

async function readTranscriptMirrorState(sessionFile: string): Promise<{
  idempotencyKeys: Set<string>;
  messageCount: number;
  userMessagesByIdempotencyKey: Map<string, MirroredUserMessage>;
}> {
  const idempotencyKeys = new Set<string>();
  const userMessagesByIdempotencyKey = new Map<string, MirroredUserMessage>();
  let messageCount = 0;
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { idempotencyKeys, messageCount, userMessagesByIdempotencyKey };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { message?: AgentMessage & { idempotencyKey?: unknown } };
      if ((parsed as { type?: unknown }).type === "message") {
        messageCount += 1;
      }
      if (typeof parsed.message?.idempotencyKey === "string") {
        idempotencyKeys.add(parsed.message.idempotencyKey);
        if (parsed.message.role === "user") {
          userMessagesByIdempotencyKey.set(parsed.message.idempotencyKey, parsed.message);
        }
      }
    } catch {
      continue;
    }
  }
  return { idempotencyKeys, messageCount, userMessagesByIdempotencyKey };
}
