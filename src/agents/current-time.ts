/**
 * Formats cron-style current-time prompt text with local and UTC references.
 */
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "./date-time.js";

type CronStyleNow = {
  userTimezone: string;
  formattedTime: string;
  timeLine: string;
};

type TimeConfigLike = {
  agents?: {
    defaults?: {
      userTimezone?: string;
      timeFormat?: "auto" | "12" | "24";
    };
  };
};

/** Resolve localized and UTC current-time text for agent prompts. */
export function resolveCronStyleNow(cfg: TimeConfigLike, nowMs: number): CronStyleNow {
  const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(undefined);
  const timestampMs = resolveDateTimestampMs(nowMs);
  const date = new Date(timestampMs);
  const formattedTime = formatUserTime(date, userTimezone, userTimeFormat) ?? date.toISOString();
  const utcTime = date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone})\nReference UTC: ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

/**
 * Append a fresh current-time block, or refresh a previously helper-injected one,
 * so heartbeat/cron prompts flowing through this helper repeatedly never leak a
 * stale `Current time:` value (issue #44993).
 */
// Matches the helper's own injected two-line `Current time: ...\nReference UTC: ...` block.
// Upstream #42654 split the helper output across two lines:
//   Line 1: `Current time: <formattedTime> (<userTimezone>)`
//   Line 2: `Reference UTC: YYYY-MM-DD HH:MM UTC`
// The natural-language `formattedTime` portion is locale/format-dependent (e.g.
// `Thursday, April 30th, 2026 - 10:00 AM` from `formatUserTime`, or an ISO fallback),
// so we anchor on the helper-only deterministic shape: `(<TZ>)` on line 1 immediately
// followed by `Reference UTC: <ISO UTC>` on line 2. The `(TZ)` group rejects parens (so
// timezone IDs like `Asia/Seoul` are accepted), and the strict `Reference UTC:` prefix
// plus ISO+UTC tail rejects user-authored reminder lines that happen to start with
// `Current time:` but lack the helper's exact two-line tail format.
const CURRENT_TIME_LINE_RE =
  /^Current time: .+? \([^)]+\)\nReference UTC: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/gm;

export function appendCronStyleCurrentTimeLine(text: string, cfg: TimeConfigLike, nowMs: number) {
  const base = text.trimEnd();
  if (!base) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs);
  if (!CURRENT_TIME_LINE_RE.test(base)) {
    return `${base}\n${timeLine}`;
  }
  CURRENT_TIME_LINE_RE.lastIndex = 0;
  let replaced = false;
  const refreshed = base.replace(CURRENT_TIME_LINE_RE, () => {
    if (replaced) {
      return "";
    }
    replaced = true;
    return timeLine;
  });
  return refreshed
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n+(?=Current time:)/g, "\n")
    .trimEnd();
}
