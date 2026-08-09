// Discord plugin module owns realtime transcript accumulation.
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const PARTIAL_TRANSCRIPT_MAX_CHARS = 240;

export function mergeRealtimePartialTranscript(previous: string, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) {
    return previous;
  }
  const merged = trimmed.startsWith(previous) ? trimmed : `${previous}${next}`;
  return sliceUtf16Safe(merged, -PARTIAL_TRANSCRIPT_MAX_CHARS);
}
