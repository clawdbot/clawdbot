// Normalizes origin route fields from inbound messages and provider context.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OriginatingChannelType } from "../templating.js";

/** Resolves the original message provider before reply redirection. */
export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeOptionalLowercaseString(params.originatingChannel) ??
    normalizeOptionalLowercaseString(params.provider)
  );
}

/** Resolves the original message target before reply redirection. */
export function resolveOriginMessageTo(params: {
  originatingTo?: string;
  to?: string;
}): string | undefined {
  return params.originatingTo ?? params.to;
}

/** Resolves the original account id before reply redirection. */
export function resolveOriginAccountId(params: {
  originatingAccountId?: string;
  accountId?: string;
}): string | undefined {
  return params.originatingAccountId ?? params.accountId;
}
