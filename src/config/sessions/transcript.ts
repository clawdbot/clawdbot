import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, normalizeStoreSessionKey } from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import type { SessionEntry } from "./types.js";

let piCodingAgentModulePromise: Promise<typeof import("@mariozechner/pi-coding-agent")> | null =
  null;

async function loadPiCodingAgentModule(): Promise<typeof import("@mariozechner/pi-coding-agent")> {
  piCodingAgentModulePromise ??= import("@mariozechner/pi-coding-agent");
  return await piCodingAgentModulePromise;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  const { CURRENT_SESSION_VERSION } = await loadPiCodingAgentModule();
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

export type LatestAssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

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

  let raw: string;
  try {
    raw = await fs.promises.readFile(sessionFile, "utf-8");
  } catch {
    return undefined;
  }

  const lines = raw.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: unknown;
      };
      const message = parsed.message as { role?: unknown; timestamp?: unknown } | undefined;
      if (!message || message.role !== "assistant") {
        continue;
      }
      const text = extractAssistantVisibleText(message)?.trim();
      if (!text) {
        continue;
      }
      return {
        ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
        text,
        ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? { timestamp: message.timestamp }
          : {}),
      };
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
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const entry = (store[normalizedKey] ?? store[sessionKey]) as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
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

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const explicitIdempotencyKey =
    params.idempotencyKey ??
    ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
  const existingMessageId = explicitIdempotencyKey
    ? await transcriptHasIdempotencyKey(sessionFile, explicitIdempotencyKey)
    : undefined;
  if (existingMessageId) {
    return { ok: true, sessionFile, messageId: existingMessageId };
  }

  const latestEquivalentAssistantId = isRedundantDeliveryMirror(params.message)
    ? await findLatestEquivalentAssistantMessageId(sessionFile, params.message)
    : undefined;
  if (latestEquivalentAssistantId) {
    return { ok: true, sessionFile, messageId: latestEquivalentAssistantId };
  }

  const message = {
    ...params.message,
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
  } as Parameters<SessionManager["appendMessage"]>[0];
  const { SessionManager } = await loadPiCodingAgentModule();
  const sessionManager = SessionManager.open(sessionFile);
  const messageId = sessionManager.appendMessage(message);

  switch (params.updateMode ?? "inline") {
    case "inline":
      emitSessionTranscriptUpdate({ sessionFile, sessionKey, message, messageId });
      break;
    case "file-only":
      emitSessionTranscriptUpdate(sessionFile);
      break;
    case "none":
      break;
  }
  return { ok: true, sessionFile, messageId };
}

async function transcriptHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          id?: unknown;
          message?: { idempotencyKey?: unknown };
        };
        if (
          parsed.message?.idempotencyKey === idempotencyKey &&
          typeof parsed.id === "string" &&
          parsed.id
        ) {
          return parsed.id;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(message);
  if (!expectedText) {
    return undefined;
  }

  try {
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          id?: unknown;
          message?: SessionTranscriptAssistantMessage;
        };
        const candidate = parsed.message;
        if (!candidate || candidate.role !== "assistant") {
          continue;
        }
        const candidateText = extractAssistantMessageText(candidate);
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
  } catch {
    return undefined;
  }

  return undefined;
}
