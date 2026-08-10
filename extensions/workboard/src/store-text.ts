import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

/** Truncate a string to at most `max` characters, appending `…` when truncated. */
export function capText(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= max ? value : `${truncateUtf16Safe(value, Math.max(0, max - 1))}…`;
}
