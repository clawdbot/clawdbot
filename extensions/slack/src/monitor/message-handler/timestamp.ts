// Slack plugin module implements timestamp behavior.
import { asFiniteNumberInRange, parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";

const SLACK_TIMESTAMP_RE = /^\d+(?:\.\d+)?$/;
const MAX_SAFE_SLACK_TIMESTAMP_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

export function resolveSlackTimestampMs(ts: string | undefined): number | undefined {
  const trimmed = ts?.trim();
  if (!trimmed || !SLACK_TIMESTAMP_RE.test(trimmed)) {
    return undefined;
  }
  const seconds = asFiniteNumberInRange(parseStrictFiniteNumber(trimmed), {
    min: 0,
    max: MAX_SAFE_SLACK_TIMESTAMP_SECONDS,
  });
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}
