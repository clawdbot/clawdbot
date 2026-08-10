import {
  resolveAnthropicFallbackModelIdentity,
  type AnthropicFallbackBoundary,
} from "./anthropic-server-fallback.js";

export type AnthropicFallbackBoundaryAuthority = "server_authoritative" | "client_provisional";

type AnthropicFallbackTransition = {
  fromModel: string;
  toModel: string;
};

export type AnthropicFallbackResolution = {
  traceValid: boolean;
  transitions: AnthropicFallbackTransition[];
  productTransitions: AnthropicFallbackBoundary[];
  servingModel?: string;
};

export type TerminalFallbackUsage =
  | { state: "invalid" }
  | {
      state: "valid";
      declinedModels: string[];
      servingModel?: string;
    };

export function readTerminalFallbackUsage(usage: unknown): TerminalFallbackUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { state: "invalid" };
  }
  const iterations = (usage as { iterations?: unknown }).iterations;
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return { state: "invalid" };
  }
  const declinedModels: string[] = [];
  let servingModel: string | undefined;
  let hasServingIdentity = false;
  for (const iteration of iterations) {
    if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) {
      return { state: "invalid" };
    }
    const record = iteration as { type?: unknown; model?: unknown };
    if (typeof record.type !== "string" || !record.type.trim()) {
      return { state: "invalid" };
    }
    switch (record.type) {
      case "message": {
        if (
          servingModel !== undefined ||
          typeof record.model !== "string" ||
          !record.model.trim()
        ) {
          return { state: "invalid" };
        }
        const previousModel = declinedModels.at(-1);
        if (
          !previousModel ||
          resolveAnthropicFallbackModelIdentity(previousModel) !==
            resolveAnthropicFallbackModelIdentity(record.model)
        ) {
          declinedModels.push(record.model);
        }
        hasServingIdentity = true;
        break;
      }
      case "fallback_message": {
        if (
          servingModel !== undefined ||
          typeof record.model !== "string" ||
          !record.model.trim()
        ) {
          return { state: "invalid" };
        }
        servingModel = record.model;
        hasServingIdentity = true;
        break;
      }
      case "advisor_message": {
        if (typeof record.model !== "string" || !record.model.trim()) {
          return { state: "invalid" };
        }
        break;
      }
      case "compaction":
        break;
      default:
        return { state: "invalid" };
    }
  }
  if (!hasServingIdentity) {
    return { state: "invalid" };
  }
  return {
    state: "valid",
    declinedModels,
    ...(servingModel ? { servingModel } : {}),
  };
}

function matchConfirmedProductTransitions(
  observed: AnthropicFallbackBoundary[],
  terminal: AnthropicFallbackTransition[],
): AnthropicFallbackBoundary[] {
  const matched: AnthropicFallbackBoundary[] = [];
  let terminalIndex = 0;
  for (const boundary of observed) {
    const fromIdentity = resolveAnthropicFallbackModelIdentity(boundary.fromModel);
    const toIdentity = resolveAnthropicFallbackModelIdentity(boundary.toModel);
    while (terminalIndex < terminal.length) {
      const transition = terminal[terminalIndex];
      terminalIndex += 1;
      if (!transition) {
        break;
      }
      if (
        resolveAnthropicFallbackModelIdentity(transition.fromModel) === fromIdentity &&
        resolveAnthropicFallbackModelIdentity(transition.toModel) === toIdentity
      ) {
        matched.push(boundary);
        break;
      }
    }
  }
  return matched;
}

function provisionalBoundariesMatchTerminal(params: {
  boundaries: Array<{ fromModel: string; toModel: string }>;
  transitions: AnthropicFallbackTransition[];
}): boolean {
  let boundaryIndex = 0;
  for (const transition of params.transitions) {
    const fromIdentity = resolveAnthropicFallbackModelIdentity(transition.fromModel);
    const toIdentity = resolveAnthropicFallbackModelIdentity(transition.toModel);
    const groupStart = boundaryIndex;
    while (boundaryIndex < params.boundaries.length) {
      const boundary = params.boundaries[boundaryIndex];
      if (!boundary || resolveAnthropicFallbackModelIdentity(boundary.fromModel) !== fromIdentity) {
        break;
      }
      boundaryIndex += 1;
    }
    const matchedBoundary = params.boundaries[boundaryIndex - 1];
    if (
      groupStart === boundaryIndex ||
      !matchedBoundary ||
      resolveAnthropicFallbackModelIdentity(matchedBoundary.toModel) !== toIdentity
    ) {
      return false;
    }
  }
  return boundaryIndex === params.boundaries.length;
}

export function reconcileAnthropicFallback(params: {
  boundaryAuthority: AnthropicFallbackBoundaryAuthority;
  requestedModel: string;
  boundaries: AnthropicFallbackBoundary[];
  confirmedProductTransitions: AnthropicFallbackBoundary[];
  terminalUsage: TerminalFallbackUsage | undefined;
}): AnthropicFallbackResolution {
  const validBoundaries = params.boundaries.filter(
    (boundary): boundary is { fromModel: string; toModel: string } =>
      Boolean(boundary.fromModel?.trim() && boundary.toModel?.trim()),
  );
  const observedProductTransitions = params.confirmedProductTransitions.map((transition) => ({
    ...transition,
  }));

  if (params.terminalUsage?.state !== "valid") {
    return {
      traceValid: false,
      transitions: [],
      productTransitions:
        params.boundaryAuthority === "server_authoritative" ? observedProductTransitions : [],
    };
  }

  const requestedIdentity = resolveAnthropicFallbackModelIdentity(params.requestedModel);
  if (!requestedIdentity) {
    return { traceValid: false, transitions: [], productTransitions: [] };
  }
  const servingModel = params.terminalUsage.servingModel;
  if (!servingModel) {
    const directTraceValid =
      params.boundaries.length === 0 &&
      params.terminalUsage.declinedModels.every(
        (model) => resolveAnthropicFallbackModelIdentity(model) === requestedIdentity,
      );
    return directTraceValid
      ? { traceValid: true, transitions: [], productTransitions: [] }
      : { traceValid: false, transitions: [], productTransitions: [] };
  }
  const servingIdentity = resolveAnthropicFallbackModelIdentity(servingModel);
  if (!servingIdentity) {
    return { traceValid: false, transitions: [], productTransitions: [] };
  }

  const firstDeclinedIdentity = resolveAnthropicFallbackModelIdentity(
    params.terminalUsage.declinedModels[0] ?? null,
  );
  if (
    params.terminalUsage.declinedModels.length > 0 &&
    firstDeclinedIdentity !== requestedIdentity
  ) {
    return { traceValid: false, transitions: [], productTransitions: [] };
  }

  const routeModels =
    params.terminalUsage.declinedModels.length > 0
      ? [...params.terminalUsage.declinedModels, servingModel]
      : [params.requestedModel, servingModel];
  const transitions: AnthropicFallbackTransition[] = [];
  const routeIdentities = new Set<string>();
  for (let index = 0; index < routeModels.length - 1; index += 1) {
    const fromModel = index === 0 ? params.requestedModel : routeModels[index];
    const toModel = routeModels[index + 1];
    const fromIdentity = resolveAnthropicFallbackModelIdentity(fromModel ?? null);
    const toIdentity = resolveAnthropicFallbackModelIdentity(toModel ?? null);
    if (
      !fromModel ||
      !toModel ||
      !fromIdentity ||
      !toIdentity ||
      fromIdentity === toIdentity ||
      (index === 0 && fromIdentity !== requestedIdentity)
    ) {
      return { traceValid: false, transitions: [], productTransitions: [] };
    }
    if (routeIdentities.has(fromIdentity)) {
      return { traceValid: false, transitions: [], productTransitions: [] };
    }
    routeIdentities.add(fromIdentity);
    transitions.push({ fromModel, toModel });
  }
  if (routeIdentities.has(servingIdentity)) {
    return { traceValid: false, transitions: [], productTransitions: [] };
  }

  const productTransitions = matchConfirmedProductTransitions(
    observedProductTransitions,
    transitions,
  );
  if (validBoundaries.length !== params.boundaries.length) {
    return { traceValid: false, transitions: [], productTransitions };
  }

  if (params.terminalUsage.declinedModels.length > 0) {
    const boundariesMatch =
      params.boundaryAuthority === "server_authoritative"
        ? validBoundaries.length === transitions.length &&
          validBoundaries.every(
            (boundary, index) =>
              resolveAnthropicFallbackModelIdentity(boundary.fromModel) ===
                resolveAnthropicFallbackModelIdentity(transitions[index]?.fromModel ?? null) &&
              resolveAnthropicFallbackModelIdentity(boundary.toModel) ===
                resolveAnthropicFallbackModelIdentity(transitions[index]?.toModel ?? null),
          )
        : provisionalBoundariesMatchTerminal({ boundaries: validBoundaries, transitions });
    if (!boundariesMatch) {
      return { traceValid: false, transitions: [], productTransitions };
    }
  } else if (validBoundaries.length > 0 || servingIdentity === requestedIdentity) {
    return { traceValid: false, transitions: [], productTransitions };
  }

  return {
    traceValid: true,
    transitions,
    productTransitions: transitions,
    servingModel,
  };
}
