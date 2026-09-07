/** Detects interim cron replies that should wait for or retry subagent work. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const SUBAGENT_FOLLOWUP_HINTS = [
  "subagent spawned",
  "spawned a subagent",
  "auto-announce when done",
  "both subagents are running",
  "wait for them to report back",
] as const;

const INTERIM_CRON_HINTS = [
  "on it",
  "pulling everything together",
  "give me a few",
  "give me a few min",
  "few minutes",
  "let me compile",
  "i'll gather",
  "i will gather",
  "working on it",
  "retrying now",
  "should be about",
  "should have your summary",
  "it'll auto-announce when done",
  "it will auto-announce when done",
  ...SUBAGENT_FOLLOWUP_HINTS,
] as const;

function normalizeHintText(value: string): string {
  return normalizeLowercaseStringOrEmpty(value).replace(/\s+/g, " ");
}

/** Detects short cron replies that probably announce work continuing elsewhere. */
export function isLikelyInterimCronMessage(value: string): boolean {
  const normalized = normalizeHintText(value);
  if (!normalized) {
    // Empty text after payload filtering means the agent either returned
    // NO_REPLY (deliberately silent) or produced no deliverable content.
    // Do not treat this as an interim acknowledgement that needs a rerun.
    return false;
  }
  const words = normalized.split(" ").filter(Boolean).length;
  return words <= 45 && INTERIM_CRON_HINTS.some((hint) => normalized.includes(hint));
}

/** Detects cron replies that explicitly promise a subagent follow-up message. */
export function expectsSubagentFollowup(value: string): boolean {
  const normalized = normalizeHintText(value);
  return Boolean(normalized && SUBAGENT_FOLLOWUP_HINTS.some((hint) => normalized.includes(hint)));
}
