/** Detects reminder commitments that were not backed by scheduled cron jobs. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { loadCronJobsStore, resolveCronJobsStorePath } from "../../cron/store.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const UNSCHEDULED_REMINDER_NOTE =
  "Note: I did not schedule a reminder in this turn, so this will not trigger automatically.";

const REMINDER_COMMITMENT_PATTERNS: RegExp[] = [
  /\b(?:i\s*['’]?ll|i will)\s+(?:make sure to\s+)?(?:remind|ping|follow up|follow-up|check (?:back|on)|circle back)\b/i,
  /\b(?:i\s*['’]?ll|i will)\s+(?:make sure to\s+)?remember\s+to\s+(?:(?:remind|ping|follow up|follow-up|check (?:back|on)|circle back)\b|(?:set|create|schedule)\s+(?:a\s+)?reminder\b)/i,
  /\b(?:i\s*['’]?ll|i will)\s+(?:make sure to\s+)?remember\b[^.!?]{0,160}?(?:\s+and(?:\s+then)?|,\s*(?:(?:and\s+)?then)?)\s+(?:(?:i\s*['’]?ll|i will|will)\s+)?(?:make sure to\s+)?(?:remind|ping|follow up|follow-up|check (?:back|on)|circle back|(?:set|create|schedule)\s+(?:a\s+)?reminder)\b/i,
  /\b(?:i\s*['’]?ll|i will)\s+(?:set|create|schedule)\s+(?:a\s+)?reminder\b/i,
];

/** Returns true when text promises a reminder/follow-up without the guard note. */
export function hasUnbackedReminderCommitment(text: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(text);
  if (!normalized.trim()) {
    return false;
  }
  if (normalized.includes(normalizeLowercaseStringOrEmpty(UNSCHEDULED_REMINDER_NOTE))) {
    return false;
  }
  return REMINDER_COMMITMENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Returns true when the cron store has at least one enabled job that shares the
 * current session key. Used to suppress the "no reminder scheduled" guard note
 * when an existing cron (created in a prior turn) already covers the commitment.
 */
export async function hasSessionRelatedCronJobs(params: {
  cronStorePath?: string;
  sessionKey?: string;
}): Promise<boolean> {
  try {
    const storePath = resolveCronJobsStorePath(params.cronStorePath);
    const store = await loadCronJobsStore(storePath);
    if (store.jobs.length === 0) {
      return false;
    }
    if (params.sessionKey) {
      return store.jobs.some((job) => job.enabled && job.sessionKey === params.sessionKey);
    }
    return false;
  } catch {
    // If we cannot read the cron store, do not suppress the note.
    return false;
  }
}

/** Appends the unscheduled-reminder note to the first payload that needs it. */
export function appendUnscheduledReminderNote(payloads: ReplyPayload[]): ReplyPayload[] {
  let appended = false;
  return payloads.map((payload) => {
    if (appended || payload.isError || typeof payload.text !== "string") {
      return payload;
    }
    if (!hasUnbackedReminderCommitment(payload.text)) {
      return payload;
    }
    appended = true;
    const trimmed = payload.text.trimEnd();
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: `${trimmed}\n\n${UNSCHEDULED_REMINDER_NOTE}`,
    });
  });
}
