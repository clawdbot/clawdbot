import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";

export function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  return normalizeOptionalStringifiedId(value);
}
