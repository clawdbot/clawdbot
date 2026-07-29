// Agent timestamp injection adds compact local-time context to direct gateway
// agent messages without double-stamping channel envelopes or cron prompts.
import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";

/**
 * Cron jobs inject "Current time: ..." into their messages.
 * Skip injection for those.
 */
const CRON_TIME_MARKER = "Current time: ";

/**
 * Matches a leading `[... YYYY-MM-DD HH:MM ...]` envelope — either from
 * channel plugins or from a previous injection. Uses the same YYYY-MM-DD
 * HH:MM format as {@link formatZonedTimestamp}, so detection stays in sync
 * with the formatting.
 */
const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

interface TimestampInjectionOptions {
  timezone?: string;
  now?: Date;
  includeTimestamp?: boolean;
}

/**
 * Build a `[DOW YYYY-MM-DD HH:MM TZ] ` prefix string from an explicit date.
 *
 * Returns undefined if formatting fails (malformed timezone etc.).
 * Does NOT guard against TIMESTAMP_ENVELOPE_PATTERN or CRON_TIME_MARKER —
 * callers that need those guards should use {@link injectTimestamp} instead.
 *
 * This is the primitive used by the persistence path to stamp each stored
 * message with ITS OWN arrival timestamp (not the current wall-clock time),
 * so historical messages carry a stable, immutable prefix.
 */
export function buildTimestampPrefix(
  date: Date,
  opts?: Pick<TimestampInjectionOptions, "timezone">,
): string | undefined {
  const timezone = opts?.timezone ?? "UTC";
  const formatted = formatZonedTimestamp(date, { timeZone: timezone });
  if (!formatted) {
    return undefined;
  }
  // 3-letter DOW: small models (8B) can't reliably derive day-of-week from
  // a date, and may treat a bare "Wed" as a typo. Costs ~1 token.
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(
    date,
  );
  return `[${dow} ${formatted}] `;
}

/**
 * Injects a compact timestamp prefix into a message if one isn't already
 * present. Uses the same `YYYY-MM-DD HH:MM TZ` format as channel envelope
 * timestamps ({@link formatZonedTimestamp}), keeping token cost low (~7
 * tokens) and format consistent across all agent contexts.
 *
 * NOTE: The standard user-turn path no longer calls this. Per-message stamps
 * are now applied once at the LLM boundary (normalizeMessagesForLlmBoundary)
 * from each message's own timestamp, so storage stays bare and the current and
 * historical sends are byte-identical — eliminating the prompt-cache bust
 * described in issue #3658. This helper is retained only for any remaining
 * non-user-turn callers and as the shared prefix primitive's wrapper.
 *
 * Channel messages (Discord, Telegram, etc.) already have timestamps via
 * envelope formatting and take a separate code path — they never reach
 * these handlers, so there is no double-stamping risk. The detection
 * pattern is a safety net for edge cases.
 *
 * @see https://github.com/openclaw/openclaw/issues/3658
 */
export function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string {
  if (opts?.includeTimestamp === false) {
    return message;
  }
  if (!message.trim()) {
    return message;
  }

  // Already has an envelope or injected timestamp
  if (TIMESTAMP_ENVELOPE_PATTERN.test(message)) {
    return message;
  }

  // Already has a cron-injected timestamp
  if (message.includes(CRON_TIME_MARKER)) {
    return message;
  }

  const now = opts?.now ?? new Date();
  const prefix = buildTimestampPrefix(now, opts);
  if (!prefix) {
    return message;
  }

  return `${prefix}${message}`;
}

/**
 * Build TimestampInjectionOptions from an OpenClawConfig.
 */
export function timestampOptsFromConfig(cfg: OpenClawConfig): TimestampInjectionOptions {
  return {
    timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
    includeTimestamp: true,
  };
}
