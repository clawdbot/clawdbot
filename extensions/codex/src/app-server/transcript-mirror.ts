// Codex plugin module implements transcript mirror behavior.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
import {
  publishSessionTranscriptUpdateByIdentity,
  withSessionTranscriptWriteLock,
  type SessionTranscriptTargetParams,
  type SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread, JsonValue } from "./protocol.js";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;

export type CodexAppServerTranscriptMirrorResult = {
  assistantMirrorIdentitiesOwned: string[];
  userMessagesPresent: MirroredUserMessage[];
};

const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;
const MIRROR_ORIGIN_META_KEY = "mirrorOrigin" as const;
const CODEX_APP_SERVER_MIRROR_ORIGIN = "codex-app-server" as const;
const CODEX_HISTORY_IMPORT_MAX_MESSAGES = 200;
const CODEX_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;
const CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES = 64 * 1024;
const CODEX_HISTORY_TRUNCATION_SUFFIX = "\n\n[Message truncated during Codex history import.]";
const CODEX_HISTORY_ASSISTANT_API = "openai-chatgpt-responses" as const;
const CODEX_HISTORY_ASSISTANT_PROVIDER = "openai";
const CODEX_HISTORY_ASSISTANT_MODEL = "native-history";
const CODEX_HISTORY_ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type CodexThreadHistoryImportResult = {
  importedMessages: number;
  omittedMessages: number;
};

export type BoundedCodexThreadHistoryProjection = CodexThreadHistoryImportResult & {
  responseItems: JsonValue[];
  transcriptMessages: AgentMessage[];
};

type ProjectedCodexHistoryMessage = {
  message: AgentMessage;
  responseItem: JsonValue;
  textBytes: number;
};

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function normalizeImportedHistoryText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") <= CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES) {
    return text;
  }
  const suffixBytes = Buffer.byteLength(CODEX_HISTORY_TRUNCATION_SUFFIX, "utf8");
  const contentLimitBytes = Math.max(0, CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES - suffixBytes);
  return `${truncateUtf8Prefix(text, contentLimitBytes)}${CODEX_HISTORY_TRUNCATION_SUFFIX}`;
}

function projectCodexUserItemText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const value of item.content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const input = value as Record<string, unknown>;
    if (input.type === "text") {
      const text = normalizeImportedHistoryText(input.text);
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (input.type === "image" || input.type === "localImage") {
      parts.push("[Image attachment]");
      continue;
    }
    if (input.type === "skill" || input.type === "mention") {
      const name = normalizeOptionalString(input.name);
      if (name) {
        parts.push(`${input.type === "skill" ? "$" : "@"}${name}`);
      }
    }
  }
  return normalizeImportedHistoryText(parts.join("\n"));
}

function selectTurnsThroughBoundary(
  thread: CodexThread,
  throughTurnId: string | null,
): NonNullable<CodexThread["turns"]> {
  if (throughTurnId === null) {
    return [];
  }
  const turns = thread.turns ?? [];
  const boundaryIndex = turns.findIndex((turn) => turn.id === throughTurnId);
  if (boundaryIndex < 0) {
    throw new Error(`Codex history boundary turn not found: ${throughTurnId}`);
  }
  const boundary = turns[boundaryIndex];
  if (
    boundary?.status !== "completed" &&
    boundary?.status !== "interrupted" &&
    boundary?.status !== "failed"
  ) {
    throw new Error(`Codex history boundary turn is not terminal: ${throughTurnId}`);
  }
  return turns.slice(0, boundaryIndex + 1);
}

function projectCodexThreadHistory(params: {
  thread: CodexThread;
  throughTurnId: string | null;
  importedAt: number;
  modelProvider?: string;
}): ProjectedCodexHistoryMessage[] {
  const projected: ProjectedCodexHistoryMessage[] = [];
  const threadTimestamp =
    typeof params.thread.createdAt === "number" && Number.isFinite(params.thread.createdAt)
      ? params.thread.createdAt * 1000
      : params.importedAt;
  let itemOffset = 0;
  for (const turn of selectTurnsThroughBoundary(params.thread, params.throughTurnId)) {
    for (const value of turn.items) {
      const item = value as unknown as Record<string, unknown>;
      const itemId = normalizeOptionalString(item.id);
      const identity = `${turn.id}:${itemId ?? itemOffset}`;
      const timestampSeconds =
        item.type === "agentMessage"
          ? (turn.completedAt ?? turn.startedAt)
          : (turn.startedAt ?? turn.completedAt);
      const timestamp =
        typeof timestampSeconds === "number" && Number.isFinite(timestampSeconds)
          ? timestampSeconds * 1000 + itemOffset
          : threadTimestamp + itemOffset;
      const text =
        item.type === "userMessage"
          ? projectCodexUserItemText(item)
          : item.type === "agentMessage"
            ? normalizeImportedHistoryText(item.text)
            : undefined;
      const role =
        item.type === "userMessage"
          ? ("user" as const)
          : item.type === "agentMessage"
            ? ("assistant" as const)
            : undefined;
      itemOffset += 1;
      if (!text || !role) {
        continue;
      }
      const message =
        role === "assistant"
          ? attachCodexMirrorIdentity(
              {
                role,
                content: [{ type: "text", text }],
                api: CODEX_HISTORY_ASSISTANT_API,
                provider:
                  normalizeOptionalString(params.modelProvider) ??
                  normalizeOptionalString(params.thread.modelProvider) ??
                  CODEX_HISTORY_ASSISTANT_PROVIDER,
                model: CODEX_HISTORY_ASSISTANT_MODEL,
                usage: CODEX_HISTORY_ZERO_USAGE,
                stopReason: "stop",
                timestamp,
              } satisfies AssistantMessage,
              identity,
            )
          : attachCodexMirrorIdentity({ role, content: text, timestamp } as AgentMessage, identity);
      const phase =
        item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
      projected.push({
        message,
        responseItem: {
          type: "message",
          role,
          content: [
            {
              type: role === "assistant" ? "output_text" : "input_text",
              text,
            },
          ],
          ...(role === "assistant" && phase ? { phase } : {}),
        },
        textBytes: Buffer.byteLength(text, "utf8"),
      });
    }
  }
  return projected;
}

function selectBoundedCodexHistoryTail(
  projected: ProjectedCodexHistoryMessage[],
): ProjectedCodexHistoryMessage[] {
  const selected: ProjectedCodexHistoryMessage[] = [];
  let selectedBytes = 0;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const candidate = projected[index];
    if (!candidate) {
      continue;
    }
    if (
      selected.length >= CODEX_HISTORY_IMPORT_MAX_MESSAGES ||
      selectedBytes + candidate.textBytes > CODEX_HISTORY_IMPORT_MAX_BYTES
    ) {
      break;
    }
    selected.push(candidate);
    selectedBytes += candidate.textBytes;
  }
  return selected.toReversed();
}

/** Projects one terminal Codex history prefix into transcript and Responses API items. */
export function projectBoundedCodexThreadHistory(params: {
  thread: CodexThread;
  throughTurnId: string | null;
  importedAt: number;
  modelProvider?: string | null;
}): BoundedCodexThreadHistoryProjection {
  const projected = projectCodexThreadHistory({
    thread: params.thread,
    throughTurnId: params.throughTurnId,
    importedAt: params.importedAt,
    ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
  });
  const selected = selectBoundedCodexHistoryTail(projected);
  return {
    importedMessages: selected.length,
    omittedMessages: projected.length - selected.length,
    responseItems: selected.map(({ responseItem }) => responseItem),
    transcriptMessages: selected.map(({ message }) => message),
  };
}

/** Imports a bounded, user-visible Codex history tail into a new OpenClaw transcript. */
export async function importCodexThreadHistoryToTranscript(params: {
  thread: CodexThread;
  throughTurnId: string | null;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  cwd?: string;
  modelProvider?: string | null;
  config?: SessionTranscriptWriteLockParams["config"];
}): Promise<CodexThreadHistoryImportResult> {
  const projection = projectBoundedCodexThreadHistory({
    thread: params.thread,
    throughTurnId: params.throughTurnId,
    importedAt: Date.now(),
    ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
  });
  if (projection.transcriptMessages.length > 0) {
    await mirrorCodexAppServerTranscript({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config: params.config } : {}),
      messages: projection.transcriptMessages,
      idempotencyScope: `codex-app-server:${params.thread.id}:history`,
    });
  }
  return {
    importedMessages: projection.importedMessages,
    omittedMessages: projection.omittedMessages,
  };
}

function attachCodexMirrorOrigin(message: AgentMessage): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  const existing = record["__openclaw"];
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [MIRROR_ORIGIN_META_KEY]: CODEX_APP_SERVER_MIRROR_ORIGIN },
  } as unknown as AgentMessage;
}

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
}): Promise<boolean> {
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
      try {
        params.notifyUserMessagePersisted(message);
      } catch (error) {
        embeddedAgentLog.warn("failed to notify codex app-server user-message persistence", {
          error: formatErrorMessage(error),
        });
      }
    }
    return mirrorResult.assistantMirrorIdentitiesOwned.includes(`${params.turnId}:assistant`);
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", { error });
    return false;
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
  sessionId: string;
  cwd?: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: SessionTranscriptWriteLockParams["config"];
}): Promise<CodexAppServerTranscriptMirrorResult> {
  const messages = params.messages.filter(
    (message): message is MirroredAgentMessage =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  if (messages.length === 0) {
    return { assistantMirrorIdentitiesOwned: [], userMessagesPresent: [] };
  }

  const transcriptTarget = resolveCodexMirrorTranscriptTarget(params);
  const mirrorBatch = await withSessionTranscriptWriteLock(
    { ...transcriptTarget, config: params.config },
    async (transcript) => {
      const nextAppendedUpdates: Array<{
        messageId: string;
        message: AgentMessage;
        messageSeq: number;
      }> = [];
      const nextAssistantMirrorIdentitiesOwned = new Set<string>();
      const nextUserMessagesPresent: MirroredUserMessage[] = [];
      const mirrorState = readTranscriptMirrorState(await transcript.readEvents());
      let nextMessageSeq = mirrorState.messageCount;
      for (const message of messages) {
        const dedupeIdentity = buildMirrorDedupeIdentity(message);
        const sourceUserIdempotencyKey =
          message.role === "user"
            ? normalizeOptionalString(
                (message as unknown as { idempotencyKey?: unknown }).idempotencyKey,
              )
            : undefined;
        // The gateway owns user-turn identity. Preserve its key so clients can
        // correlate optimistic rows; provider mirror identity is only a fallback.
        const idempotencyKey =
          sourceUserIdempotencyKey ??
          (params.idempotencyScope ? `${params.idempotencyScope}:${dedupeIdentity}` : undefined);
        const transcriptMessage = {
          ...(attachCodexMirrorOrigin(message) as unknown as Record<string, unknown>),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } as AgentMessage;
        if (idempotencyKey && mirrorState.idempotencyKeys.has(idempotencyKey)) {
          const persistedUserMessage = mirrorState.userMessagesByIdempotencyKey.get(idempotencyKey);
          if (persistedUserMessage) {
            nextUserMessagesPresent.push(persistedUserMessage);
          }
          if (message.role === "assistant") {
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        const nextMessage = runAgentHarnessBeforeMessageWriteHook({
          message: transcriptMessage,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
        if (!nextMessage) {
          if (message.role === "assistant") {
            // A transcript hook deliberately blocked this logical assistant row.
            // Treat that as an authoritative persistence decision so delivery
            // does not bypass the hook with a fallback mirror.
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        const messageToAppend = (
          idempotencyKey
            ? {
                ...(attachCodexMirrorOrigin(nextMessage) as unknown as Record<string, unknown>),
                idempotencyKey,
              }
            : attachCodexMirrorOrigin(nextMessage)
        ) as AgentMessage;
        const appended = await transcript.appendMessage({
          message: messageToAppend,
          idempotencyLookup: idempotencyKey ? "caller-checked" : "scan",
          cwd: params.cwd,
        });
        if (!appended) {
          continue;
        }
        const { messageId, message: appendedMessage } = appended;
        if (message.role === "assistant") {
          nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
        }
        if (appendedMessage.role === "user") {
          nextUserMessagesPresent.push(appendedMessage);
          if (idempotencyKey) {
            mirrorState.userMessagesByIdempotencyKey.set(idempotencyKey, appendedMessage);
          }
        }
        nextMessageSeq += 1;
        nextAppendedUpdates.push({
          messageId,
          message: appendedMessage,
          messageSeq: nextMessageSeq,
        });
        if (idempotencyKey) {
          mirrorState.idempotencyKeys.add(idempotencyKey);
        }
      }
      return {
        appendedUpdates: nextAppendedUpdates,
        assistantMirrorIdentitiesOwned: [...nextAssistantMirrorIdentitiesOwned],
        userMessagesPresent: nextUserMessagesPresent,
      };
    },
  );
  const { appendedUpdates, assistantMirrorIdentitiesOwned, userMessagesPresent } = mirrorBatch;

  for (const update of appendedUpdates) {
    try {
      await publishSessionTranscriptUpdateByIdentity({
        ...transcriptTarget,
        update: {
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.agentId ? { agentId: params.agentId } : {}),
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        },
      });
    } catch (error) {
      // The transcript append is already committed. A transient live-update
      // failure must not make dispatch append a second assistant message.
      embeddedAgentLog.warn("failed to publish codex app-server transcript update", {
        error: formatErrorMessage(error),
      });
    }
  }

  return { assistantMirrorIdentitiesOwned, userMessagesPresent };
}

function resolveCodexMirrorTranscriptTarget(params: {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
}): SessionTranscriptTargetParams {
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? "",
  };
}

function readTranscriptMirrorState(events: unknown[]): {
  idempotencyKeys: Set<string>;
  messageCount: number;
  userMessagesByIdempotencyKey: Map<string, MirroredUserMessage>;
} {
  const idempotencyKeys = new Set<string>();
  const userMessagesByIdempotencyKey = new Map<string, MirroredUserMessage>();
  let messageCount = 0;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const parsed = event as {
      message?: AgentMessage & { idempotencyKey?: unknown };
      type?: unknown;
    };
    if (parsed.type === "message") {
      messageCount += 1;
    }
    if (typeof parsed.message?.idempotencyKey === "string") {
      idempotencyKeys.add(parsed.message.idempotencyKey);
      if (parsed.message.role === "user") {
        userMessagesByIdempotencyKey.set(parsed.message.idempotencyKey, parsed.message);
      }
    }
  }
  return {
    idempotencyKeys,
    messageCount,
    userMessagesByIdempotencyKey,
  };
}
