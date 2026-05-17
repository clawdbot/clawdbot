import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";

export const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
export const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
};
type HistoryEntry = {
  type?: unknown;
  message?: unknown;
  summary?: unknown;
  customType?: unknown;
  content?: unknown;
  display?: unknown;
  details?: unknown;
  timestamp?: unknown;
  fromId?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
};

type RawTranscriptReseedReason =
  | "auth-profile"
  | "auth-epoch"
  | "system-prompt"
  | "mcp"
  | "missing-transcript"
  | "session-expired";

const RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS = new Set<RawTranscriptReseedReason>([
  "missing-transcript",
  "system-prompt",
  "mcp",
  "session-expired",
]);

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function coerceHistoryTimestamp(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return 0;
}

function historyEntryToContextEngineMessage(entry: HistoryEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message as AgentMessage;
  }
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: typeof entry.customType === "string" ? entry.customType : "custom",
      content: entry.content,
      display: entry.display !== false,
      details: entry.details,
      timestamp: coerceHistoryTimestamp(entry.timestamp),
    } as AgentMessage;
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      fromId: typeof entry.fromId === "string" ? entry.fromId : "root",
      timestamp: coerceHistoryTimestamp(entry.timestamp),
    } as AgentMessage;
  }
  return undefined;
}

function loadContextEngineMessagesFromEntries(entries: unknown[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    const message = historyEntryToContextEngineMessage(entry as HistoryEntry);
    return message ? [message] : [];
  });
}

export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
  maxHistoryChars?: number;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  const renderedHistoryRaw = params.messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") {
        return [];
      }
      const entry = message as HistoryMessage;
      const role =
        entry.role === "assistant"
          ? "Assistant"
          : entry.role === "user"
            ? "User"
            : entry.role === "compactionSummary"
              ? "Compaction summary"
              : undefined;
      if (!role) {
        return [];
      }
      const text =
        entry.role === "compactionSummary" && typeof entry.summary === "string"
          ? entry.summary.trim()
          : coerceHistoryText(entry.content);
      return text ? [`${role}: ${text}`] : [];
    })
    .join("\n\n")
    .trim();
  const renderedHistory =
    renderedHistoryRaw.length > maxHistoryChars
      ? `${renderedHistoryRaw.slice(0, maxHistoryChars).trimEnd()}\n[OpenClaw reseed history truncated]`
      : renderedHistoryRaw;

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

async function safeRealpath(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(filePath);
  } catch {
    return undefined;
  }
}

function resolveSafeCliSessionFile(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): { sessionFile: string; sessionsDir: string } {
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const pathOptions = resolveSessionFilePathOptions({
    agentId: sessionAgentId ?? defaultAgentId,
    storePath: params.config?.session?.store,
  });
  const sessionFile = resolveSessionFilePath(
    params.sessionId,
    { sessionFile: params.sessionFile },
    pathOptions,
  );
  return {
    sessionFile,
    sessionsDir: pathOptions?.sessionsDir ?? path.dirname(sessionFile),
  };
}

async function loadCliSessionEntries(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  try {
    const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
    const entryStat = await fsp.lstat(sessionFile);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return [];
    }
    const realSessionsDir = (await safeRealpath(sessionsDir)) ?? path.resolve(sessionsDir);
    const realSessionFile = await safeRealpath(sessionFile);
    if (
      !realSessionFile ||
      realSessionFile === realSessionsDir ||
      !isPathInside(realSessionsDir, realSessionFile)
    ) {
      return [];
    }
    const stat = await fsp.stat(realSessionFile);
    if (!stat.isFile() || stat.size > MAX_CLI_SESSION_HISTORY_FILE_BYTES) {
      return [];
    }
    const entries = parseSessionEntries(await fsp.readFile(realSessionFile, "utf-8"));
    migrateSessionEntries(entries);
    return entries.filter((entry) => entry.type !== "session");
  } catch {
    return [];
  }
}

export async function hasCliSessionTranscript(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<boolean> {
  try {
    const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
    const entryStat = await fsp.lstat(sessionFile);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return false;
    }
    const realSessionsDir = (await safeRealpath(sessionsDir)) ?? path.resolve(sessionsDir);
    const realSessionFile = await safeRealpath(sessionFile);
    if (
      !realSessionFile ||
      realSessionFile === realSessionsDir ||
      !isPathInside(realSessionsDir, realSessionFile)
    ) {
      return false;
    }
    const stat = await fsp.stat(realSessionFile);
    return stat.isFile() && stat.size <= MAX_CLI_SESSION_HISTORY_FILE_BYTES;
  } catch {
    return false;
  }
}

export async function loadCliSessionHistoryMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  const history = (await loadCliSessionEntries(params)).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
}

export async function loadCliSessionContextEngineMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadContextEngineMessagesFromEntries(entries);
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadContextEngineMessagesFromEntries(entries);
  }

  const tailMessages = loadContextEngineMessagesFromEntries(
    entries.slice(latestCompactionIndex + 1),
  );
  return [
    {
      role: "compactionSummary",
      summary,
      timestamp: coerceHistoryTimestamp(compaction.timestamp),
      tokensBefore: typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : 0,
      ...(typeof compaction.tokensAfter === "number"
        ? { tokensAfter: compaction.tokensAfter }
        : {}),
      ...(typeof compaction.firstKeptEntryId === "string"
        ? { firstKeptEntryId: compaction.firstKeptEntryId }
        : {}),
      ...(compaction.details !== undefined ? { details: compaction.details } : {}),
    },
    ...tailMessages,
  ];
}

export async function loadCliSessionReseedMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  allowRawTranscriptReseed?: boolean;
  rawTranscriptReseedReason?: RawTranscriptReseedReason;
}): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const loadRawTail = () => {
    if (
      params.allowRawTranscriptReseed !== true ||
      !params.rawTranscriptReseedReason ||
      !RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS.has(params.rawTranscriptReseedReason)
    ) {
      return [];
    }
    const rawTail = entries.flatMap((entry) => {
      const candidate = entry as HistoryEntry;
      return candidate.type === "message" ? [candidate.message] : [];
    });
    return limitAgentHookHistoryMessages(rawTail, MAX_CLI_SESSION_HISTORY_MESSAGES);
  };
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadRawTail();
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadRawTail();
  }

  const tailMessages = entries.slice(latestCompactionIndex + 1).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return [
    {
      role: "compactionSummary",
      summary,
    },
    ...limitAgentHookHistoryMessages(tailMessages, MAX_CLI_SESSION_HISTORY_MESSAGES - 1),
  ];
}
