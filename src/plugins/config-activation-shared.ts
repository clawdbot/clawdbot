type EnableStateLike = {
  enabled: boolean;
  reason?: string;
};

type EnableStateParamsLike = {
  id: string;
  origin: string;
  config: unknown;
  enabledByDefault?: boolean;
};

type PluginKindLike = string | readonly string[] | undefined;

export function toEnableStateResult(state: EnableStateLike): { enabled: boolean; reason?: string } {
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}

export function resolveEnableStateResult<TParams>(
  params: TParams,
  resolveState: (params: TParams) => EnableStateLike,
): { enabled: boolean; reason?: string } {
  return toEnableStateResult(resolveState(params));
}

export function resolveEnableStateShared<TParams extends EnableStateParamsLike>(
  params: TParams,
  resolveState: (params: TParams) => EnableStateLike,
): { enabled: boolean; reason?: string } {
  return resolveEnableStateResult(params, resolveState);
}

function hasKind(kind: PluginKindLike, target: string): boolean {
  if (!kind) {
    return false;
  }
  return Array.isArray(kind) ? kind.includes(target) : kind === target;
}

export function resolveMemorySlotDecisionShared(params: {
  id: string;
  kind?: PluginKindLike;
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (!hasKind(params.kind, "memory")) {
    return { enabled: true };
  }
  // A dual-kind plugin (e.g. ["memory", "context-engine"]) that lost the
  // memory slot must stay enabled so its other slot role can still load.
  const isMultiKind = Array.isArray(params.kind) && params.kind.length > 1;
  if (params.slot === null) {
    return isMultiKind ? { enabled: true } : { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot set to "${params.slot}"` };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot already filled by "${params.selectedId}"` };
  }
  return { enabled: true, selected: true };
}
