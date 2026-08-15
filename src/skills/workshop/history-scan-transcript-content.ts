import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { filterHeartbeatTranscriptTurns } from "../../auto-reply/heartbeat-transcript-turns.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  countSkillModelIterations,
  formatSkillExperienceReviewTranscript,
} from "./experience-review-prompt.js";

const HISTORY_SCAN_MAX_RECENT_MESSAGES = 80;
const HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

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
    const rendered = formatSkillExperienceReviewTranscript([message]);
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
    redactSensitiveText(formatSkillExperienceReviewTranscript(messages), { mode: "tools" }),
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
