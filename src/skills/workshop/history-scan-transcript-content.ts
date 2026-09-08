import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { filterHeartbeatTranscriptTurns } from "../../auto-reply/heartbeat-transcript-turns.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { countSkillModelIterations } from "./experience-review-prompt.js";

const HISTORY_SCAN_MAX_RECENT_MESSAGES = 80;
const HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return safeJson(content);
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!isRecord(block)) {
        return safeJson(block);
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (["toolCall", "tool_use", "function_call"].includes(String(block.type))) {
        const toolName = typeof block.name === "string" ? block.name : "unknown";
        return `[tool call: ${toolName}] ${safeJson(
          block.arguments ?? block.input ?? block.args ?? {},
        )}`;
      }
      return safeJson(block);
    })
    .join("\n");
}

function renderMessage(message: unknown): string {
  if (!isRecord(message)) {
    return `[unknown]\n${safeJson(message)}`;
  }
  const role = typeof message.role === "string" ? message.role : "unknown";
  const error = message.isError === true ? " error" : "";
  const toolName = typeof message.toolName === "string" ? ` ${message.toolName}` : "";
  return `[${role}${toolName}${error}]\n${renderContent(message.content)}`;
}

function formatSkillHistoryMessages(messages: readonly unknown[]): string {
  return messages.map(renderMessage).join("\n\n");
}

function capSessionTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }
  const omission = "\n\n[older session content omitted]\n\n";
  if (maxChars <= omission.length) {
    return truncateUtf16Safe(transcript, maxChars);
  }
  const contentBudget = Math.max(0, maxChars - omission.length);
  const headLength = Math.min(2_000, Math.floor(contentBudget / 2));
  const head = truncateUtf16Safe(transcript, headLength);
  const tail = sliceUtf16Safe(transcript, -(contentBudget - head.length));
  return `${head}${omission}${tail}`;
}

function hasLegacyHookTranscriptContent(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    if (!isRecord(message) || message.role !== "user") {
      return false;
    }
    const rendered = formatSkillHistoryMessages([message]);
    return (
      (rendered.includes("<<<EXTERNAL_UNTRUSTED_CONTENT") &&
        /(?:^|\n)Source: (?:Email|Webhook)(?:\n|$)/.test(rendered)) ||
      /(?:^|\n)\[cron:[^\]\n]+\](?: |$)/.test(rendered)
    );
  });
}

function filterSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): readonly unknown[] | undefined {
  if (hasLegacyHookTranscriptContent(messages)) {
    return undefined;
  }
  const roleMessages = messages.filter(
    (message): message is { role: string; content?: unknown } =>
      isRecord(message) && typeof message.role === "string",
  );
  return filterHeartbeatTranscriptTurns(roleMessages, heartbeatPrompt);
}

export function prepareSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): { messages: readonly unknown[]; modelIterations: number } | undefined {
  const filtered = filterSkillHistoryScanReviewMessages(messages, heartbeatPrompt);
  if (!filtered) {
    return undefined;
  }
  return {
    messages: filtered.slice(-HISTORY_SCAN_MAX_RECENT_MESSAGES),
    modelIterations: countSkillModelIterations(filtered),
  };
}

export function formatSkillHistoryScanTranscript(
  messages: readonly unknown[],
  maxChars: number,
): string {
  // Redact the complete structure first. Truncating first can split a PEM or
  // other multiline secret so the remaining fragment no longer matches.
  return capSessionTranscript(
    // Provider-bound history uses mandatory built-in patterns. Operator log
    // redaction mode and custom pattern replacement cannot weaken this seam.
    redactSensitiveText(formatSkillHistoryMessages(messages), { mode: "tools" }),
    maxChars,
  );
}

export function isSkillHistoryScanLocalTranscriptSizeEligible(sizeBytes: number): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    sizeBytes >= 0 &&
    sizeBytes <= HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES
  );
}
