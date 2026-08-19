import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type SourceReplyDeliveryModeOrigin = "stable_policy" | "runtime_default";

export type SourceReplyDeliveryRuntimeOptions = {
  sourceReplyDeliveryModeOrigin?: SourceReplyDeliveryModeOrigin;
  onSourceReplyDeliveryModeResolved?: (mode: SourceReplyDeliveryMode) => void;
};

type SourceReplyDeliveryProjection = {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  extraSystemPrompt?: string;
};

type SourceReplyDeliveryRuntime = {
  readonly origin: SourceReplyDeliveryModeOrigin;
  readonly currentMode: SourceReplyDeliveryMode;
  track: (owner: SourceReplyDeliveryProjection) => void;
  applyMode: (owner: SourceReplyDeliveryProjection, mode: SourceReplyDeliveryMode) => void;
  applyPreparedMode: (owner: SourceReplyDeliveryProjection, mode: SourceReplyDeliveryMode) => void;
};

const sourceReplyDeliveryRuntimeKey = "__openclawSourceReplyDeliveryRuntime" as const;
type SourceReplyDeliveryRuntimeOwner = {
  [sourceReplyDeliveryRuntimeKey]?: SourceReplyDeliveryRuntime;
};

export function bindSourceReplyDeliveryRuntime(
  owner: object,
  runtime: SourceReplyDeliveryRuntime,
): void {
  (owner as SourceReplyDeliveryRuntimeOwner)[sourceReplyDeliveryRuntimeKey] = runtime;
}

export function readSourceReplyDeliveryRuntime(
  owner: object,
): SourceReplyDeliveryRuntime | undefined {
  return (owner as SourceReplyDeliveryRuntimeOwner)[sourceReplyDeliveryRuntimeKey];
}

export function createSourceReplyDeliveryRuntime(params: {
  origin: SourceReplyDeliveryModeOrigin;
  initialMode: SourceReplyDeliveryMode;
  projections: SourceReplyDeliveryProjection[];
  promptComponentByMode: Record<SourceReplyDeliveryMode, string>;
  promptComponentOffset: number | undefined;
  onModeResolved?: (mode: SourceReplyDeliveryMode) => void;
}): SourceReplyDeliveryRuntime {
  const projections = new Set(params.projections);
  let currentMode = params.initialMode;
  const applyMode = (
    owner: SourceReplyDeliveryProjection,
    mode: SourceReplyDeliveryMode,
    updatePrompt: boolean,
  ) => {
    currentMode = mode;
    for (const projection of new Set([...projections, owner])) {
      projection.sourceReplyDeliveryMode = mode;
      if (!updatePrompt) {
        continue;
      }
      const nextComponent = params.promptComponentByMode[mode];
      const prompt = projection.extraSystemPrompt;
      if (!nextComponent || !prompt) {
        continue;
      }
      const offset = params.promptComponentOffset ?? -1;
      const currentComponent = [...new Set(Object.values(params.promptComponentByMode))].find(
        (component) => component && prompt.slice(offset, offset + component.length) === component,
      );
      // Replace only the delivery-owned prompt component. Later context additions
      // must survive prepared harness selection instead of restoring a stale prompt.
      if (currentComponent && currentComponent !== nextComponent && offset >= 0) {
        projection.extraSystemPrompt =
          prompt.slice(0, offset) + nextComponent + prompt.slice(offset + currentComponent.length);
      }
    }
    params.onModeResolved?.(mode);
  };
  const runtime: SourceReplyDeliveryRuntime = {
    origin: params.origin,
    get currentMode() {
      return currentMode;
    },
    track: (owner) => projections.add(owner),
    applyMode: (owner, mode) => applyMode(owner, mode, false),
    applyPreparedMode: (owner, mode) => applyMode(owner, mode, true),
  };
  return runtime;
}
