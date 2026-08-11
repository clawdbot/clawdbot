import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type SourceReplyDeliveryModeOrigin = "stable_policy" | "runtime_default";

export type SourceReplyDeliveryRuntimeOptions = {
  sourceReplyDeliveryModeOrigin?: SourceReplyDeliveryModeOrigin;
  onSourceReplyDeliveryModeResolved?: (mode: SourceReplyDeliveryMode) => void;
};

// The shared enumerable binding follows queue/run spreads without widening their public types.
// Its listener moves prepared ownership before live callbacks; copying only the mode would leave
// pre-settlement source delivery on the preliminary policy.
const sourceReplyDeliveryModeOriginKey: unique symbol = Symbol.for(
  "openclaw.source-reply-delivery-runtime",
);
type SourceReplyDeliveryRuntimeBinding = {
  origin?: SourceReplyDeliveryModeOrigin;
  preparedHarnessMode?: SourceReplyDeliveryMode;
  preparedHarnessModeListener?: (mode: SourceReplyDeliveryMode) => void;
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
    binding.preparedHarnessModeListener?.(mode);
  }
}

export function bindPreparedHarnessSourceReplyDeliveryMode(
  owner: object,
  listener: (mode: SourceReplyDeliveryMode) => void,
): () => void {
  const binding = readSourceReplyDeliveryRuntimeBinding(owner);
  if (binding?.origin !== "runtime_default") {
    return () => {};
  }
  binding.preparedHarnessModeListener = listener;
  return () => {
    if (binding.preparedHarnessModeListener === listener) {
      binding.preparedHarnessModeListener = undefined;
    }
  };
}

export function readPreparedHarnessSourceReplyDeliveryMode(
  owner: object,
): SourceReplyDeliveryMode | undefined {
  return readSourceReplyDeliveryRuntimeBinding(owner)?.preparedHarnessMode;
}
