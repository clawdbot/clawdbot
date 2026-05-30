import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, resolveSessionStoreEntry } from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { writeJsonlEntry } from "./transcript-jsonl.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import { streamSessionTranscriptLinesReverse } from "./transcript-stream.js";
import {
  runWithOwnedSessionTranscriptWriteLock,
  runWithOwnedSessionTranscriptWritePublication,
} from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd?: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = createSessionTranscriptHeader({ sessionId: params.sessionId, cwd: params.cwd });
  await writeJsonlEntry(params.sessionFile, header, { mode: 0o600 });
}

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type LatestAssistantTranscriptText = AssistantTranscriptText;
export type TailAssistantTranscriptText = AssistantTranscriptText;

function parseAssistantTranscriptText(
  line: string,
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): AssistantTranscriptText | undefined {
  const parsed = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as
    | { role?: unknown; timestamp?: unknown; provider?: unknown; model?: unknown }
    | undefined;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    options?.excludeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantMessage(message)
  ) {
    return undefined;
  }
  const text = extractAssistantVisibleText(message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function isTranscriptOnlyOpenClawAssistantMessage(message: {
  provider?: unknown;
  model?: unknown;
}): boolean {
  return (
    message.provider === "openclaw" &&
    (message.model === "delivery-mirror" || message.model === "gateway-injected")
  );
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

export async function readLatestAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<LatestAssistantTranscriptText | undefined> {
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const assistantText = parseAssistantTranscriptText(line, {
        excludeTranscriptOnlyOpenClawAssistant: true,
      });
      if (assistantText) {
        return assistantText;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readTailAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<TailAssistantTranscriptText | undefined> {
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const parsed = JSON.parse(line) as { message?: unknown };
      // Skip non-message entries (e.g. `openclaw.cache-ttl` custom events) so
      // a metadata line emitted after the canonical assistant turn doesn't
      // make the tail reader fall through to "no assistant tail" and cause
      // persistTextTurnTranscript to append a duplicate. Stop at any real
      // message entry — a user turn means a new turn has started and a
      // matching reply is a legitimate repeat, not a gap-fill duplicate.
      if (!parsed.message || typeof parsed.message !== "object") {
        continue;
      }
      return parseAssistantTranscriptText(line);
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    updateMode: params.updateMode,
    config: params.config,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  const entry = resolved.existing;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey: resolved.normalizedKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: formatErrorMessage(err),
    };
  }

  return await runWithOwnedSessionTranscriptWriteLock(
    { sessionFile, sessionKey: resolved.normalizedKey },
    async () => {
      const explicitIdempotencyKey =
        params.idempotencyKey ??
        ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
      const latestEquivalentAssistantId = isRedundantDeliveryMirror(params.message)
        ? await findLatestEquivalentAssistantMessageId(sessionFile, params.message, params.config)
        : undefined;
      if (latestEquivalentAssistantId) {
        return { ok: true, sessionFile, messageId: latestEquivalentAssistantId };
      }
      const message = {
        ...params.message,
        ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
      } as Parameters<SessionManager["appendMessage"]>[0];
      const {
        messageId,
        message: appendedMessage,
        appended,
      } = await runWithOwnedSessionTranscriptWritePublication(
        { sessionFile, sessionKey: resolved.normalizedKey },
        async () => {
          await ensureSessionHeader({
            sessionFile,
            sessionId: entry.sessionId,
            cwd: entry.spawnedCwd,
          });
          return await appendSessionTranscriptMessage({
            transcriptPath: sessionFile,
            message,
            ...(explicitIdempotencyKey ? { idempotencyLookup: "scan" } : {}),
            config: params.config,
          });
        },
      );
      if (!appended) {
        return { ok: true, sessionFile, messageId };
      }

      switch (params.updateMode ?? "inline") {
        case "inline":
          emitSessionTranscriptUpdate({
            sessionFile,
            sessionKey,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            message: appendedMessage,
            messageId,
          });
          break;
        case "file-only":
          emitSessionTranscriptUpdate({
            sessionFile,
            sessionKey,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          });
          break;
        case "none":
          break;
      }
      return { ok: true, sessionFile, messageId };
    },
  );
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function extractAssistantMessageText(message: SessionTranscriptAssistantMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

async function findLatestEquivalentAssistantMessageId(
  transcriptPath: string,
  message: SessionTranscriptAssistantMessage,
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(
    redactTranscriptMessage(message, config) as unknown as SessionTranscriptAssistantMessage,
  );
  if (!expectedText) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: SessionTranscriptAssistantMessage;
      };
      const candidate = parsed.message;
      if (!candidate || candidate.role !== "assistant") {
        continue;
      }
      const candidateText = extractAssistantMessageText(
        redactTranscriptMessage(
          candidate as AgentMessage,
          config,
        ) as unknown as SessionTranscriptAssistantMessage,
      );
      if (candidateText !== expectedText) {
        return undefined;
      }
      if (typeof parsed.id === "string" && parsed.id) {
        return parsed.id;
      }
      return undefined;
    } catch {
      continue;
    }
  }

  return undefined;
}
