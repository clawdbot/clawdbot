import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OriginatingChannelType } from "../templating.js";

export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeOptionalLowercaseString(params.originatingChannel) ??
    normalizeOptionalLowercaseString(params.provider)
  );
}

export function resolveOriginMessageTo(params: {
  originatingTo?: string;
  to?: string;
}): string | undefined {
  return params.originatingTo ?? params.to;
}

export function resolveOriginAccountId(params: {
  originatingAccountId?: string;
  accountId?: string;
}): string | undefined {
  return params.originatingAccountId ?? params.accountId;
}
