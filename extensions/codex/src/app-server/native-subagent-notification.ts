/**
 * Extracts native Codex subagent completion notifications from trusted
 * inter-agent commentary messages emitted by the app-server.
 */
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const CODEX_SUBAGENT_NOTIFICATION_START = "<subagent_notification>";
const CODEX_SUBAGENT_NOTIFICATION_END = "</subagent_notification>";

/** Terminal status values OpenClaw accepts for Codex native subagent completion. */
type CodexNativeSubagentCompletionStatus = "succeeded" | "failed" | "cancelled";

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
type CodexNativeSubagentNotificationCompletion = CodexNativeSubagentCompletionDetails & {
  agentPath: string;
};

/** Extracts trusted subagent completion payloads from a Codex server notification. */
function extractCodexNativeSubagentCompletions(
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
  const communication = readTrustedInterAgentCommunication(item);
  const text = communication?.content;
  if (typeof text !== "string" || !text) {
    return [];
  }
  return extractCodexNativeSubagentCompletionsFromText(text).filter(
    (completion) => completion.agentPath === communication?.author,
  );
}

/** Parses one or more tagged subagent completion payloads from commentary text. */
function extractCodexNativeSubagentCompletionsFromText(
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

export const codexNativeSubagentNotifications = {
  fromNotification: extractCodexNativeSubagentCompletions,
  fromText: extractCodexNativeSubagentCompletionsFromText,
  deliveredAgentPaths: readDeliveredNativeCompletionPaths,
};

/** Reads native delivery receipts, leaving status and result ownership with the child lifecycle. */
function readDeliveredNativeCompletionPaths(notification: CodexServerNotification): string[] {
  if (notification.method !== "rawResponseItem/completed") {
    return [];
  }
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const item = isJsonObject(params?.item) ? params.item : undefined;
  if (!item || readString(item, "type") !== "agent_message") {
    return extractCodexNativeSubagentCompletions(notification).map(
      (completion) => completion.agentPath,
    );
  }
  const author = readString(item, "author");
  const recipient = readString(item, "recipient");
  const content = item.content;
  if (!author || !recipient || !Array.isArray(content) || content.length !== 1) {
    return [];
  }
  const part = content[0];
  if (!isJsonObject(part) || readString(part, "type") !== "input_text") {
    return [];
  }
  const text = readString(part, "text");
  // Codex's native completion envelope identifies both endpoints outside the
  // payload. Ordinary messages and quoted completion text are not receipts.
  return text?.startsWith(
    `Message Type: FINAL_ANSWER\nTask name: ${recipient}\nSender: ${author}\nPayload:\n`,
  )
    ? [author]
    : [];
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
    const result = stringifyResult(value, mappedStatus);
    const noFinalAssistantMessage =
      mappedStatus === "succeeded" && result.kind === "no_final_assistant_message";
    return {
      status: mappedStatus,
      label: noFinalAssistantMessage ? "completed_without_final_message" : rawKey,
      result: result.text,
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

function stringifyResult(
  value: JsonValue | undefined,
  status: CodexNativeSubagentCompletionStatus,
): {
  text: string;
  kind?: "no_final_assistant_message";
} {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      return { text };
    }
    return status === "succeeded"
      ? completedWithoutFinalAssistantMessage()
      : { text: "(no output)" };
  }
  if (value === null || value === undefined) {
    return status === "succeeded"
      ? completedWithoutFinalAssistantMessage()
      : { text: "(no output)" };
  }
  try {
    return { text: JSON.stringify(value) };
  } catch {
    return { text: "(unserializable output)" };
  }
}

function completedWithoutFinalAssistantMessage(): {
  text: string;
  kind: "no_final_assistant_message";
} {
  return {
    text: "Codex native subagent completed without a final assistant message.",
    kind: "no_final_assistant_message",
  };
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

function normalizeStatusKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
