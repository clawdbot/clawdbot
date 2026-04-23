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

export interface TimestampInjectionOptions {
  timezone?: string;
  now?: Date;
}

/**
 * Injects a compact timestamp prefix into a message if one isn't already
 * present. Uses the same `YYYY-MM-DD HH:MM TZ` format as channel envelope
 * timestamps ({@link formatZonedTimestamp}), keeping token cost low (~7
 * tokens) and format consistent across all agent contexts.
 *
 * Used by the gateway `agent` and `chat.send` handlers to give TUI, web,
 * spawned subagents, `sessions_send`, and heartbeat wake events date/time
 * awareness — without modifying the system prompt (which is cached).
 *
 * Channel messages (Discord, Telegram, etc.) already have timestamps via
 * envelope formatting and take a separate code path — they never reach
 * these handlers, so there is no double-stamping risk. The detection
 * pattern is a safety net for edge cases.
 *
 * @see https://github.com/openclaw/openclaw/issues/3658
 */
export function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string {
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
  const timezone = opts?.timezone ?? "UTC";

  const formatted = formatZonedTimestamp(now, { timeZone: timezone });
  if (!formatted) {
    return message;
  }

  // 3-letter DOW: small models (8B) can't reliably derive day-of-week from
  // a date, and may treat a bare "Wed" as a typo. Costs ~1 token.
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(
    now,
  );

  return `[${dow} ${formatted}] ${message}`;
}

/**
 * Build TimestampInjectionOptions from an OpenClawConfig.
 */
export function timestampOptsFromConfig(cfg: OpenClawConfig): TimestampInjectionOptions {
  return {
    timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
  };
}
