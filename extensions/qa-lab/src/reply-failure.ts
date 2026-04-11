import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const FAILURE_REPLY_PREFIXES = [
  "⚠️ something went wrong while processing your request.",
  "⚠️ session history got out of sync.",
  "⚠️ session history was corrupted.",
  "⚠️ context overflow",
  "⚠️ message ordering conflict.",
  "⚠️ model login expired on the gateway",
  "⚠️ model login failed on the gateway",
  "⚠️ agent failed before reply:",
  "⚠️ ✉️ message failed",
  "⚠️ no api key found for provider ",
  "⚠️ missing api key for ",
];

export function extractQaFailureReplyText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (FAILURE_REPLY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return trimmed;
  }
  return undefined;
}
