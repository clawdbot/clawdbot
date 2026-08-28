import type { EmbeddedAgentRunMeta } from "../../agents/embedded-agent-runner/types.js";

function normalizeCompactionCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function resolveOperationalRunCompactionCount(
  meta: EmbeddedAgentRunMeta | undefined,
): number {
  const currentTurnCount = normalizeCompactionCount(meta?.contextManagement?.lastTurnCompactions);
  if (currentTurnCount !== undefined) {
    return currentTurnCount;
  }

  const requiresDiagnosticFallback =
    meta?.error?.kind === "incomplete_turn" || meta?.timeoutPhase !== undefined;
  if (!requiresDiagnosticFallback) {
    return 0;
  }

  return normalizeCompactionCount(meta?.agentMeta?.compactionCount) ?? 0;
}
