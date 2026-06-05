/**
 * Extracts native Codex subagent completion notifications from trusted
 * inter-agent commentary messages emitted by the app-server.
 */
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const CODEX_SUBAGENT_NOTIFICATION_START = "<subagent_notification>";
const CODEX_SUBAGENT_NOTIFICATION_END = "</subagent_notification>";

/** Terminal status values OpenClaw accepts for Codex native subagent completion. */
export type CodexNativeSubagentCompletionStatus = "succeeded" | "failed" | "cancelled";

type CodexNativeSubagentCompletionDetails = {
  status: CodexNativeSubagentCompletionStatus;
  statusLabel: string;
  result: string;
};

/** Completion associated with a resolved child thread id. */
export type CodexNativeSubagentCompletion = CodexNativeSubagentCompletionDetails & {
  childThreadId: string;
};

/** Completion parsed from a notification payload before agent-path matching resolves the thread. */
export type CodexNativeSubagentNotificationCompletion = CodexNativeSubagentCompletionDetails & {
  agentPath: string;
};

/** Extracts trusted subagent completion payloads from a Codex server notification. */
export function extractCodexNativeSubagentCompletions(
  notification: CodexServerNotification,
): CodexNativeSubagentNotificationCompletion[] {
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  if (!params) {
    return [];
  }
  const item = isJsonObject(params.item) ? params.item : undefined;
  if (!item) {
    return [];
  }
  const text = readTrustedInterAgentCommunicationContent(item);
  if (!text) {
    return [];
  }
  const author = readTrustedInterAgentCommunicationAuthor(item);
  return extractCodexNativeSubagentCompletionsFromText(text).filter(
    (completion) => completion.agentPath === author,
  );
}

/** Parses one or more tagged subagent completion payloads from commentary text. */
export function extractCodexNativeSubagentCompletionsFromText(
  text: string,
): CodexNativeSubagentNotificationCompletion[] {
  const completions: CodexNativeSubagentNotificationCompletion[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(CODEX_SUBAGENT_NOTIFICATION_START, cursor);
    if (start < 0) {
      break;
    }
    const bodyStart = start + CODEX_SUBAGENT_NOTIFICATION_START.length;
    const end = text.indexOf(CODEX_SUBAGENT_NOTIFICATION_END, bodyStart);
    if (end < 0) {
      break;
    }
    const parsed = parseCodexNativeSubagentNotificationBody(text.slice(bodyStart, end));
    if (parsed) {
      completions.push(parsed);
    }
    cursor = end + CODEX_SUBAGENT_NOTIFICATION_END.length;
  }
  return completions;
}

function parseCodexNativeSubagentNotificationBody(
  body: string,
): CodexNativeSubagentNotificationCompletion | undefined {
  let payload: JsonValue;
  try {
    payload = JSON.parse(body.trim());
  } catch {
    return undefined;
  }
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const agentPath = readString(payload, "agent_path")?.trim();
  const status = isJsonObject(payload.status) ? payload.status : undefined;
  if (!agentPath || !status) {
    return undefined;
  }
  const statusEntry = readCompletionStatus(status);
  if (!statusEntry) {
    return undefined;
  }
  return {
    agentPath,
    status: statusEntry.status,
    statusLabel: statusEntry.label,
    result: statusEntry.result,
  };
}

function readCompletionStatus(status: JsonObject):
  | {
      status: CodexNativeSubagentCompletionStatus;
      label: string;
      result: string;
    }
  | undefined {
  for (const [rawKey, value] of Object.entries(status)) {
    const normalized = normalizeStatusKey(rawKey);
    const mappedStatus = mapCompletionStatus(normalized);
    if (!mappedStatus) {
      continue;
    }
    return {
      status: mappedStatus,
      label: rawKey,
      result: stringifyResult(value),
    };
  }
  return undefined;
}

function mapCompletionStatus(value: string): CodexNativeSubagentCompletionStatus | undefined {
  if (value === "completed" || value === "succeeded" || value === "success") {
    return "succeeded";
  }
  if (
    value === "cancelled" ||
    value === "canceled" ||
    value === "interrupted" ||
    value === "shutdown"
  ) {
    return "cancelled";
  }
  if (
    value === "failed" ||
    value === "error" ||
    value === "errored" ||
    value === "systemerror" ||
    value === "notfound"
  ) {
    return "failed";
  }
  return undefined;
}

function stringifyResult(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value.trim() || "(no output)";
  }
  if (value === null || value === undefined) {
    return "(no output)";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "(unserializable output)";
  }
}

function readTrustedInterAgentCommunicationContent(item: JsonObject): string | undefined {
  const communication = readTrustedInterAgentCommunication(item);
  return typeof communication?.content === "string" ? communication.content : undefined;
}

function readTrustedInterAgentCommunicationAuthor(item: JsonObject): string | undefined {
  const communication = readTrustedInterAgentCommunication(item);
  return typeof communication?.author === "string" ? communication.author : undefined;
}

function readTrustedInterAgentCommunication(item: JsonObject): JsonObject | undefined {
  if (
    readString(item, "type") !== "message" ||
    readString(item, "role") !== "assistant" ||
    readString(item, "phase") !== "commentary"
  ) {
    return undefined;
  }
  const text = extractSingleTextPart(item);
  if (!text) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  if (
    typeof parsed.author !== "string" ||
    typeof parsed.recipient !== "string" ||
    typeof parsed.content !== "string" ||
    parsed.trigger_turn !== false
  ) {
    return undefined;
  }
  return parsed;
}

function extractSingleTextPart(item: JsonObject): string | undefined {
  const content = item.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const [entry] = content;
  if (!isJsonObject(entry)) {
    return undefined;
  }
  const type = readString(entry, "type");
  if (type !== "output_text" && type !== "text") {
    return undefined;
  }
  return readString(entry, "text")?.trim();
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeStatusKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
