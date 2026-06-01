import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";

/** Normalizes channel thread/topic ids before outbound payload construction. */
export function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  return normalizeOptionalStringifiedId(value);
}
