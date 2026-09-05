import type { AgentRuntimeAuthModelRoute } from "./types.js";

function normalizeRouteBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function sameCompatibleRuntimeIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  if (leftIds.size !== rightIds.size) {
    return false;
  }
  for (const id of leftIds) {
    if (!rightIds.has(id)) {
      return false;
    }
  }
  return true;
}

/** Compares the complete secret-free identity of two prepared model routes. */
export function sameAgentRuntimeAuthModelRoute(
  left: AgentRuntimeAuthModelRoute,
  right: AgentRuntimeAuthModelRoute,
): boolean {
  return (
    left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.modelId === right.modelId &&
    left.api === right.api &&
    left.authRequirement === right.authRequirement &&
    left.requestTransportOverrides === right.requestTransportOverrides &&
    sameCompatibleRuntimeIds(
      left.runtimePolicy?.compatibleIds,
      right.runtimePolicy?.compatibleIds,
    ) &&
    normalizeRouteBaseUrl(left.baseUrl) === normalizeRouteBaseUrl(right.baseUrl)
  );
}
