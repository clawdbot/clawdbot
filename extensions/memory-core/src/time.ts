// Memory Core plugin module implements time behavior.
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";

export function resolveMemoryCoreNowMs(nowMs: unknown): number {
  return timestampMsToIsoString(nowMs) === undefined ? Date.now() : (nowMs as number);
}

export function resolveMemoryCoreTimestamp(nowMs: unknown): string {
  const timestampMs = resolveMemoryCoreNowMs(nowMs);
  return timestampMsToIsoString(timestampMs) ?? new Date().toISOString();
}
