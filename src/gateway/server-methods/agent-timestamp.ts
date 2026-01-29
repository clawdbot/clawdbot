import {
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "../../agents/date-time.js";
import type { MoltbotConfig } from "../../config/types.js";

/**
 * Envelope pattern used by channel plugins (Discord, Telegram, etc.):
 *   [Channel sender 2026-01-28 20:31 EST] message text
 *
 * Messages arriving through channels already have timestamps.
 * We skip injection for those to avoid double-stamping.
 */
const ENVELOPE_PATTERN = /^\[[\w]+ .+ \d{4}-\d{2}-\d{2}/;

/**
 * Cron jobs inject "Current time: ..." into their messages.
 * Skip injection for those too.
 */
const CRON_TIME_PATTERN = /Current time: /;

export interface TimestampInjectionOptions {
  timezone?: string;
  timeFormat?: "12" | "24";
  now?: Date;
}

/**
 * Injects a timestamp prefix into a message if one isn't already present.
 *
 * Used by the gateway agent handler to give all agent contexts (TUI, web,
 * spawned subagents, sessions_send, heartbeats) date/time awareness without
 * modifying the system prompt (which is cached for stability).
 *
 * Channel messages (Discord, Telegram, etc.) already have timestamps via
 * envelope formatting and take a separate code path — they never reach
 * the agent handler, so there's no double-stamping risk.
 *
 * @see https://github.com/moltbot/moltbot/issues/3658
 */
export function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string {
  if (!message.trim()) return message;

  // Already has a channel envelope timestamp
  if (ENVELOPE_PATTERN.test(message)) return message;

  // Already has a cron-injected timestamp
  if (CRON_TIME_PATTERN.test(message)) return message;

  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "UTC";
  const timeFormat = opts?.timeFormat ?? "12";

  const formatted = formatUserTime(now, timezone, resolveUserTimeFormat(timeFormat));
  if (!formatted) return message;

  return `[${formatted}] ${message}`;
}

/**
 * Build TimestampInjectionOptions from a MoltbotConfig.
 */
export function timestampOptsFromConfig(cfg: MoltbotConfig): TimestampInjectionOptions {
  return {
    timezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
    timeFormat: cfg.agents?.defaults?.timeFormat as "12" | "24" | undefined,
  };
}
