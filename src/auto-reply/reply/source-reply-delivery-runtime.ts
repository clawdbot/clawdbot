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
  promptComponentByMode?: Record<SourceReplyDeliveryMode, string>;
  promptComponentOffset?: number;
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

export function setSourceReplyDeliveryPromptComponents(
  owner: object,
  components: Record<SourceReplyDeliveryMode, string>,
  componentOffset: number | undefined,
): void {
  const binding = readSourceReplyDeliveryRuntimeBinding(owner) ?? {};
  binding.promptComponentByMode = components;
  binding.promptComponentOffset = componentOffset;
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
    const components = binding.promptComponentByMode;
    const nextComponent = components?.[mode];
    const promptOwner = owner as { extraSystemPrompt?: string };
    const prompt = promptOwner.extraSystemPrompt;
    if (components && nextComponent && prompt) {
      const offset = binding.promptComponentOffset ?? -1;
      const currentComponent = [...new Set(Object.values(components))].find(
        (component) => component && prompt.slice(offset, offset + component.length) === component,
      );
      // Replace only the delivery-owned prompt component. Later context additions
      // must survive prepared harness selection instead of restoring a stale prompt.
      if (currentComponent && currentComponent !== nextComponent && offset >= 0) {
        promptOwner.extraSystemPrompt =
          prompt.slice(0, offset) + nextComponent + prompt.slice(offset + currentComponent.length);
        binding.promptComponentOffset = offset;
      }
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
