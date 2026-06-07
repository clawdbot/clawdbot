// Qa Lab plugin module implements suite runtime agent session behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isRecord,
  normalizeOptionalString as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createDirectReplyTranscriptSentinelScanner } from "./gateway-log-sentinel.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionStoreEntry,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
} from "./suite-runtime-types.js";

type QaGatewayCallEnv = Pick<
  QaSuiteRuntimeEnv,
  "gateway" | "primaryModel" | "alternateModel" | "providerMode"
>;

const SESSION_STORE_LOCK_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;
const SESSION_TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const SESSION_TRANSCRIPT_LINE_MAX_BYTES = 1024 * 1024;
let sessionStoreLockRetryDelaysMsForTests: readonly number[] | undefined;

function resolveSessionStoreLockRetryDelaysMs(): readonly number[] {
  return sessionStoreLockRetryDelaysMsForTests ?? SESSION_STORE_LOCK_RETRY_DELAYS_MS;
}

type QaSessionTranscriptSummary = {
  finalText: string;
  hasDirectReplySelfMessage: boolean;
};

function isSessionStoreLockTimeout(error: unknown) {
  const text = formatErrorMessage(error);
  return (
    text.includes("OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT") ||
    text.includes("OPENCLAW_SESSION_WRITE_LOCK_STALE") ||
    text.includes("SessionWriteLockTimeoutError") ||
    text.includes("SessionWriteLockStaleError") ||
    text.includes("session file locked") ||
    text.includes("session file lock stale")
  );
}

function extractSessionTranscriptText(message: Record<string, unknown>) {
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of rawContent) {
    if (typeof block === "string") {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    const text = readNonEmptyString(block.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const content = readNonEmptyString(block.content);
    if (
      content &&
      (block.type === "output_text" || block.type === "text" || block.type === "message")
    ) {
      parts.push(content);
    }
  }
  return parts.join("\n").trim();
}

function readSessionTranscriptLineMessage(line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) && isRecord(parsed.message) ? parsed.message : undefined;
  } catch {
    // Ignore malformed transcript rows and keep QA summary checks deterministic.
    return undefined;
  }
}

function appendSessionTranscriptLineChunk(params: {
  pendingLine: string;
  pendingLineBytes: number;
  chunk: string;
  sessionKey: string;
}) {
  const pendingLine = params.pendingLine + params.chunk;
  const pendingLineBytes = params.pendingLineBytes + Buffer.byteLength(params.chunk, "utf8");
  if (pendingLineBytes > SESSION_TRANSCRIPT_LINE_MAX_BYTES) {
    throw new Error(
      `session transcript line exceeded ${SESSION_TRANSCRIPT_LINE_MAX_BYTES} bytes for ${params.sessionKey}`,
    );
  }
  return { pendingLine, pendingLineBytes };
}

async function readSessionTranscriptFileSummary(
  transcriptPath: string,
  sessionKey: string,
): Promise<QaSessionTranscriptSummary> {
  const scanner = createDirectReplyTranscriptSentinelScanner();
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(SESSION_TRANSCRIPT_READ_CHUNK_BYTES);
  let finalText = "";
  let pendingLine = "";
  let pendingLineBytes = 0;
  let hasTranscriptContent = false;

  const processLine = (line: string) => {
    if (line.trim()) {
      hasTranscriptContent = true;
    }
    const message = readSessionTranscriptLineMessage(line);
    if (!message || message.role !== "assistant") {
      return;
    }
    const text = extractSessionTranscriptText(message);
    if (text) {
      finalText = text;
    }
    scanner.recordMessage(message);
  };

  const file = await fs.open(transcriptPath, "r");
  try {
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      let chunk = decoder.write(buffer.subarray(0, bytesRead));
      for (;;) {
        const lineEnd = chunk.indexOf("\n");
        if (lineEnd === -1) {
          const appended = appendSessionTranscriptLineChunk({
            pendingLine,
            pendingLineBytes,
            chunk,
            sessionKey,
          });
          pendingLine = appended.pendingLine;
          pendingLineBytes = appended.pendingLineBytes;
          break;
        }
        const appended = appendSessionTranscriptLineChunk({
          pendingLine,
          pendingLineBytes,
          chunk: chunk.slice(0, lineEnd),
          sessionKey,
        });
        processLine(appended.pendingLine);
        pendingLine = "";
        pendingLineBytes = 0;
        chunk = chunk.slice(lineEnd + 1);
      }
    }
    const finalChunk = decoder.end();
    if (finalChunk) {
      const appended = appendSessionTranscriptLineChunk({
        pendingLine,
        pendingLineBytes,
        chunk: finalChunk,
        sessionKey,
      });
      pendingLine = appended.pendingLine;
      pendingLineBytes = appended.pendingLineBytes;
    }
    if (pendingLine) {
      processLine(pendingLine);
    }
  } finally {
    await file.close();
  }

  if (!hasTranscriptContent) {
    throw new Error(`session transcript is empty for ${sessionKey}`);
  }

  return {
    finalText,
    hasDirectReplySelfMessage: scanner.findings().length > 0,
  };
}

async function callGatewayWithSessionStoreLockRetry<T>(
  env: QaGatewayCallEnv,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number },
) {
  const retryDelaysMs = resolveSessionStoreLockRetryDelaysMs();
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return (await env.gateway.call(method, params, options)) as T;
    } catch (error) {
      if (!isSessionStoreLockTimeout(error) || attempt === retryDelaysMs.length) {
        throw error;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw new Error(`${method} failed after session store lock retries`);
}

async function createSession(env: QaGatewayCallEnv, label: string, key?: string) {
  const created = await callGatewayWithSessionStoreLockRetry<{ key?: string }>(
    env,
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  );
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaGatewayCallEnv, sessionKey: string) {
  const payload = await callGatewayWithSessionStoreLockRetry<{
    groups?: Array<{ tools?: Array<{ id?: string }> }>;
  }>(
    env,
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  );
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(env: QaGatewayCallEnv, agentId = "qa") {
  const payload = await callGatewayWithSessionStoreLockRetry<{
    skills?: QaSkillStatusEntry[];
  }>(
    env,
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  );
  return payload.skills ?? [];
}

function resolveQaSessionTranscriptFile(params: {
  sessionsDir: string;
  sessionId: string;
  sessionFile?: string;
}) {
  const explicit = readNonEmptyString(params.sessionFile);
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(params.sessionsDir, explicit);
  }
  return path.join(params.sessionsDir, `${params.sessionId}.jsonl`);
}

async function readRawQaSessionStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const storePath = path.join(
    env.gateway.tempRoot,
    "state",
    "agents",
    "qa",
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as Record<string, QaRawSessionStoreEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readSessionTranscriptSummary(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
): Promise<QaSessionTranscriptSummary> {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    throw new Error("readSessionTranscriptSummary requires a session key");
  }
  const store = await readRawQaSessionStore(env);
  const entry = store[normalizedSessionKey];
  const sessionId = readNonEmptyString(entry?.sessionId);
  if (!sessionId) {
    throw new Error(`session transcript entry not found for ${normalizedSessionKey}`);
  }
  const sessionsDir = path.join(env.gateway.tempRoot, "state", "agents", "qa", "sessions");
  const transcriptPath = resolveQaSessionTranscriptFile({
    sessionsDir,
    sessionId,
    sessionFile: entry?.sessionFile,
  });
  return readSessionTranscriptFileSummary(transcriptPath, normalizedSessionKey);
}

export {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
  setSessionStoreLockRetryDelaysMsForTests,
};

function setSessionStoreLockRetryDelaysMsForTests(delays?: readonly number[]): void {
  sessionStoreLockRetryDelaysMsForTests = delays;
}
