import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { scanDirectReplyTranscriptSentinels } from "./gateway-log-sentinel.js";
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

type QaSessionTranscriptSummary = {
  finalText: string;
  hasDirectReplySelfMessage: boolean;
};

function isSessionStoreLockTimeout(error: unknown) {
  const text = formatErrorMessage(error);
  return (
    text.includes("OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT") ||
    text.includes("SessionWriteLockTimeoutError") ||
    text.includes("session file locked")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function extractFinalAssistantTextFromTranscript(transcriptBytes: string) {
  let finalText = "";
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const message = isRecord(parsed) && isRecord(parsed.message) ? parsed.message : undefined;
      if (!message || message.role !== "assistant") {
        continue;
      }
      const text = extractSessionTranscriptText(message);
      if (text) {
        finalText = text;
      }
    } catch {
      // Ignore malformed transcript rows and keep QA summary checks deterministic.
    }
  }
  return finalText;
}

async function callGatewayWithSessionStoreLockRetry<T>(
  env: QaGatewayCallEnv,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number },
) {
  for (let attempt = 0; attempt <= SESSION_STORE_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return (await env.gateway.call(method, params, options)) as T;
    } catch (error) {
      if (
        !isSessionStoreLockTimeout(error) ||
        attempt === SESSION_STORE_LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(SESSION_STORE_LOCK_RETRY_DELAYS_MS[attempt]);
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
  const transcriptBytes = await fs.readFile(transcriptPath, "utf8");
  if (!transcriptBytes.trim()) {
    throw new Error(`session transcript is empty for ${normalizedSessionKey}`);
  }
  return {
    finalText: extractFinalAssistantTextFromTranscript(transcriptBytes),
    hasDirectReplySelfMessage: scanDirectReplyTranscriptSentinels(transcriptBytes).length > 0,
  };
}

export {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
};
