import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type SourceReplyDeliveryModeOrigin = "stable_policy" | "runtime_default";

export type SourceReplyDeliveryRuntimeOptions = {
  sourceReplyDeliveryModeOrigin?: SourceReplyDeliveryModeOrigin;
  onSourceReplyDeliveryModeResolved?: (mode: SourceReplyDeliveryMode) => void;
};

// Enumerable symbol metadata follows queue-owned run spreads without widening its public type.
// Losing it would let a failed candidate's runtime default govern the fallback winner.
const sourceReplyDeliveryModeOriginKey: unique symbol = Symbol("sourceReplyDeliveryModeOrigin");
type SourceReplyDeliveryModeOwner = {
  [sourceReplyDeliveryModeOriginKey]?: SourceReplyDeliveryModeOrigin;
};

export function setSourceReplyDeliveryModeOrigin(
  owner: object,
  origin: SourceReplyDeliveryModeOrigin | undefined,
): void {
  (owner as SourceReplyDeliveryModeOwner)[sourceReplyDeliveryModeOriginKey] = origin;
}

export function readSourceReplyDeliveryModeOrigin(
  owner: object,
): SourceReplyDeliveryModeOrigin | undefined {
  return (owner as SourceReplyDeliveryModeOwner)[sourceReplyDeliveryModeOriginKey];
}
