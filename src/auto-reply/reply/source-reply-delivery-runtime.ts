import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type SourceReplyDeliveryModeOrigin = "stable_policy" | "runtime_default";

export type SourceReplyDeliveryRuntimeOptions = {
  sourceReplyDeliveryModeOrigin?: SourceReplyDeliveryModeOrigin;
  onSourceReplyDeliveryModeResolved?: (mode: SourceReplyDeliveryMode) => void;
};

// The shared enumerable binding follows queue/run spreads without widening their public types.
// Its listener and bounded prompt pair move prepared ownership before prompt/live callbacks;
// plugin handoff strips this symbol so neither mutable authority nor alternate prompt leaks.
const sourceReplyDeliveryModeOriginKey: unique symbol = Symbol.for(
  "openclaw.source-reply-delivery-runtime",
);
type SourceReplyDeliveryRuntimeBinding = {
  origin?: SourceReplyDeliveryModeOrigin;
  preparedHarnessMode?: SourceReplyDeliveryMode;
  preparedHarnessModeListener?: (mode: SourceReplyDeliveryMode) => void;
  extraSystemPromptByMode?: Record<SourceReplyDeliveryMode, string>;
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

export function setSourceReplyDeliveryPromptVariants(
  owner: object,
  variants: Record<SourceReplyDeliveryMode, string>,
): void {
  const binding = readSourceReplyDeliveryRuntimeBinding(owner) ?? {};
  binding.extraSystemPromptByMode = variants;
  (owner as SourceReplyDeliveryModeOwner)[sourceReplyDeliveryModeOriginKey] = binding;
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
    const extraSystemPrompt = binding.extraSystemPromptByMode?.[mode];
    if (extraSystemPrompt !== undefined) {
      (owner as { extraSystemPrompt?: string }).extraSystemPrompt = extraSystemPrompt;
    }
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
