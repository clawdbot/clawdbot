import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const SLACK_THREAD_TS_PATTERN = /^\d+\.\d+$/;

export function normalizeSlackThreadTsCandidate(
  value?: string | number | null,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalString(value);
  return normalized && SLACK_THREAD_TS_PATTERN.test(normalized) ? normalized : undefined;
}

export function resolveSlackThreadTsValue(params: {
  replyToId?: string | number | null;
  threadId?: string | number | null;
}): string | undefined {
  return (
    normalizeSlackThreadTsCandidate(params.replyToId) ??
    normalizeSlackThreadTsCandidate(params.threadId)
  );
}
