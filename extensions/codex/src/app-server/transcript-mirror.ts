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
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
  readCodexMirrorSourceFingerprint,
} from "./transcript-mirror-attestation.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";
import {
  buildResolvedCodexUserPromptMessage,
  buildCodexUserPromptMessage,
} from "./user-prompt-message.js";

export { buildCodexUserPromptMessage };

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;
type CodexAppServerTranscriptMirrorResult = {
  assistantMirrorIdentitiesOwned: string[];
  messagesPresent: MirroredAgentMessage[];
  userMessagesPresent: MirroredUserMessage[];
};

function isMirroredAgentMessage(message: AgentMessage): message is MirroredAgentMessage {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

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

type CodexThreadHistoryImportResult = {
  importedMessages: number;
  omittedMessages: number;
};

type BoundedCodexThreadHistoryProjection = CodexThreadHistoryImportResult & {
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
  storePath: string;
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
    await mirror({
      storePath: params.storePath,
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

async function mirrorBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: (message: Extract<AgentMessage, { role: "user" }>) => void;
  result: EmbeddedRunAttemptResult;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<{
  assistantTranscriptOwned: boolean;
  mirroredMessages: MirroredAgentMessage[];
}> {
  try {
    const messages = await resolveFinalCodexMirrorMessages({
      params: params.params,
      messagesSnapshot: params.result.messagesSnapshot,
      turnId: params.turnId,
    });
    const mirrorResult = await mirror({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      storePath: params.params.sessionTarget?.storePath,
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
    const expectedFingerprints = new Map(
      messages.flatMap((message) => {
        if (!isMirroredAgentMessage(message)) {
          return [];
        }
        const identity = readMirrorIdentity(message);
        return identity ? [[identity, fingerprintCodexMirrorSourceMessage(message)] as const] : [];
      }),
    );
    const mirroredMessages = mirrorResult.messagesPresent.filter((message) => {
      const identity = readMirrorIdentity(message);
      return (
        identity !== undefined &&
        readCodexMirrorSourceFingerprint(message) === expectedFingerprints.get(identity)
      );
    });
    return {
      assistantTranscriptOwned: mirrorResult.assistantMirrorIdentitiesOwned.includes(
        `${params.turnId}:assistant`,
      ),
      mirroredMessages,
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", { error });
    return { assistantTranscriptOwned: false, mirroredMessages: [] };
  }
}

async function resolveFinalCodexMirrorMessages(params: {
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
  const promptSnapshot = params.messagesSnapshot.find((message) => message.role === "user");
  const resolvedBase = attachCodexMirrorIdentity(
    await buildResolvedCodexUserPromptMessage(params.params),
    `${params.turnId}:prompt`,
  );
  const upstreamUserText = readUpstreamUserText(promptSnapshot);
  const resolvedPrompt = upstreamUserText
    ? attachUpstreamUserText(resolvedBase, upstreamUserText)
    : resolvedBase;
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
  upstreamUserText: string;
}): Promise<void> {
  if (params.params.suppressNextUserMessagePersistence) {
    return;
  }
  try {
    const mirrorPromise = (async () => {
      const userPromptMessage = attachUpstreamUserText(
        attachCodexMirrorIdentity(
          await buildResolvedCodexUserPromptMessage(params.params),
          `${params.turnId}:prompt`,
        ),
        params.upstreamUserText,
      );
      const mirrorResult = await mirror({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.params.sessionId,
        storePath: params.params.sessionTarget?.storePath,
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

async function mirror(params: {
  sessionId: string;
  cwd?: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: SessionTranscriptWriteLockParams["config"];
  skipBeforeMessageWriteHooks?: boolean;
}): Promise<CodexAppServerTranscriptMirrorResult> {
  const messages = params.messages.filter(isMirroredAgentMessage);
  if (messages.length === 0) {
    return { assistantMirrorIdentitiesOwned: [], messagesPresent: [], userMessagesPresent: [] };
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
      const nextMessagesPresent: MirroredAgentMessage[] = [];
      const nextUserMessagesPresent: MirroredUserMessage[] = [];
      const mirrorState = readTranscriptMirrorState(await transcript.readEvents());
      let nextMessageSeq = mirrorState.messageCount;
      for (const message of messages) {
        const dedupeIdentity = buildMirrorDedupeIdentity(message);
        const sourceFingerprint = fingerprintCodexMirrorSourceMessage(message);
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
          ...(attachCodexMirrorAttestation(message, sourceFingerprint) as unknown as Record<
            string,
            unknown
          >),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } as AgentMessage;
        if (idempotencyKey && mirrorState.idempotencyKeys.has(idempotencyKey)) {
          const persistedMessage = mirrorState.messagesByIdempotencyKey.get(idempotencyKey);
          if (persistedMessage) {
            nextMessagesPresent.push(persistedMessage);
          }
          const persistedUserMessage =
            persistedMessage?.role === "user" ? persistedMessage : undefined;
          if (persistedUserMessage) {
            nextUserMessagesPresent.push(persistedUserMessage);
          }
          if (message.role === "assistant") {
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        const nextMessage = params.skipBeforeMessageWriteHooks
          ? transcriptMessage
          : runAgentHarnessBeforeMessageWriteHook({
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
        let messageToAppend = (
          idempotencyKey
            ? {
                ...(attachCodexMirrorAttestation(
                  nextMessage,
                  sourceFingerprint,
                ) as unknown as Record<string, unknown>),
                idempotencyKey,
              }
            : attachCodexMirrorAttestation(nextMessage, sourceFingerprint)
        ) as AgentMessage;
        const mirrorIdentity = readMirrorIdentity(message);
        if (mirrorIdentity) {
          // Hooks may replace the whole message. Restore the provider-owned
          // identity so retries cannot turn a stale idempotency hit into evidence.
          messageToAppend = attachCodexMirrorIdentity(messageToAppend, mirrorIdentity);
        }
        const appended = await transcript.appendMessage({
          message: messageToAppend,
          idempotencyLookup: idempotencyKey ? "caller-checked" : "scan",
          cwd: params.cwd,
        });
        if (!appended) {
          continue;
        }
        const { messageId, message: appendedMessage } = appended;
        if (isMirroredAgentMessage(appendedMessage)) {
          nextMessagesPresent.push(appendedMessage);
          if (idempotencyKey) {
            mirrorState.messagesByIdempotencyKey.set(idempotencyKey, appendedMessage);
          }
        }
        if (message.role === "assistant") {
          nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
        }
        if (appendedMessage.role === "user") {
          nextUserMessagesPresent.push(appendedMessage);
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
        messagesPresent: nextMessagesPresent,
        userMessagesPresent: nextUserMessagesPresent,
      };
    },
  );
  const { appendedUpdates, assistantMirrorIdentitiesOwned, messagesPresent, userMessagesPresent } =
    mirrorBatch;

  for (const update of appendedUpdates) {
    try {
      await publishSessionTranscriptUpdateByIdentity({
        ...transcriptTarget,
        update: {
          ...(params.agentId ? { agentId: params.agentId } : {}),
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
          sessionKey: transcriptTarget.sessionKey,
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

  return { assistantMirrorIdentitiesOwned, messagesPresent, userMessagesPresent };
}

export const codexTranscriptMirrorRuntime = { mirror, mirrorBestEffort };

function resolveCodexMirrorTranscriptTarget(params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): SessionTranscriptTargetParams {
  const sessionKey = params.sessionKey?.trim();
  const storePath = params.storePath?.trim();
  if (!sessionKey || !storePath) {
    throw new Error("Codex transcript mirror requires a runtime session identity");
  }
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey,
    storePath,
  };
}

function readTranscriptMirrorState(events: unknown[]): {
  idempotencyKeys: Set<string>;
  messagesByIdempotencyKey: Map<string, MirroredAgentMessage>;
  messageCount: number;
} {
  const idempotencyKeys = new Set<string>();
  const messagesByIdempotencyKey = new Map<string, MirroredAgentMessage>();
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
      if (isMirroredAgentMessage(parsed.message)) {
        messagesByIdempotencyKey.set(parsed.message.idempotencyKey, parsed.message);
      }
    }
  }
  return {
    idempotencyKeys,
    messagesByIdempotencyKey,
    messageCount,
  };
}
