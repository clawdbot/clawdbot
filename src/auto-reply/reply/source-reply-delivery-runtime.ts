import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type SourceReplyDeliveryModeOrigin = "stable_policy" | "runtime_default";

export type SourceReplyDeliveryRuntimeOptions = {
  sourceReplyDeliveryModeOrigin?: SourceReplyDeliveryModeOrigin;
  onSourceReplyDeliveryModeResolved?: (mode: SourceReplyDeliveryMode) => void;
};

// Enumerable symbol metadata follows queue-owned run spreads without widening its public type.
// Losing it would let a failed candidate's runtime default govern the fallback winner.
const sourceReplyDeliveryModeOriginKey: unique symbol = Symbol.for(
  "openclaw.source-reply-delivery-runtime",
);
type SourceReplyDeliveryRuntimeBinding = {
  origin?: SourceReplyDeliveryModeOrigin;
  preparedHarnessMode?: SourceReplyDeliveryMode;
};
type SourceReplyDeliveryModeOwner = {
  [sourceReplyDeliveryModeOriginKey]?: SourceReplyDeliveryRuntimeBinding;
};

function readSourceReplyDeliveryRuntimeBinding(
  owner: object,
): SourceReplyDeliveryRuntimeBinding | undefined {
  return (owner as SourceReplyDeliveryModeOwner)[sourceReplyDeliveryModeOriginKey];
}

export function setSourceReplyDeliveryModeOrigin(
  owner: object,
  origin: SourceReplyDeliveryModeOrigin | undefined,
): void {
  const binding = readSourceReplyDeliveryRuntimeBinding(owner) ?? {};
  binding.origin = origin;
  (owner as SourceReplyDeliveryModeOwner)[sourceReplyDeliveryModeOriginKey] = binding;
}

export function readSourceReplyDeliveryModeOrigin(
  owner: object,
): SourceReplyDeliveryModeOrigin | undefined {
  return readSourceReplyDeliveryRuntimeBinding(owner)?.origin;
}

export function copySourceReplyDeliveryRuntimeBinding(source: object, target: object): void {
  const binding = readSourceReplyDeliveryRuntimeBinding(source);
  if (binding) {
    (target as SourceReplyDeliveryModeOwner)[sourceReplyDeliveryModeOriginKey] = binding;
  }
}

export function publishPreparedHarnessSourceReplyDeliveryMode(
  owner: object,
  mode: SourceReplyDeliveryMode,
): void {
  const binding = readSourceReplyDeliveryRuntimeBinding(owner);
  if (binding?.origin === "runtime_default") {
    binding.preparedHarnessMode = mode;
  }
}

export function readPreparedHarnessSourceReplyDeliveryMode(
  owner: object,
): SourceReplyDeliveryMode | undefined {
  return readSourceReplyDeliveryRuntimeBinding(owner)?.preparedHarnessMode;
}
