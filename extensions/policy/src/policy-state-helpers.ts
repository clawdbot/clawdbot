// Shared policy evidence path and value helpers.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  if (value.includes('"') || value.includes("\\")) {
    return value;
  }
  return `"${value}"`;
}

export function readBooleanPath(value: unknown, path: readonly string[]): boolean | undefined {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

/** One configured agent, from either the keyed `agents.entries` map or the legacy `agents.list` array. */
type PolicyConfiguredAgent = {
  readonly agentId: string;
  readonly container: "entries" | "list";
  /** Key for `entries`, array index for `list`. Feed to {@link policyAgentPathSegment}. */
  readonly pathId: string;
  readonly value: unknown;
};

/**
 * Collect configured agents from `cfg.agents`, preferring the keyed `entries` map and
 * falling back to the legacy `list` array.
 *
 * Scanners must go through this helper. Reading `agents.list` directly makes a scanner
 * blind to every agent on configs that `doctor` has already migrated to `agents.entries`,
 * which silently downgrades scoped policy rules to the global/default posture.
 */
export function collectPolicyConfiguredAgents(
  agents: Record<string, unknown>,
): readonly PolicyConfiguredAgent[] {
  const entries = isRecord(agents.entries)
    ? Object.entries(agents.entries).map(([entryId, value]) => ({
        agentId: entryId,
        container: "entries" as const,
        pathId: entryId,
        value,
      }))
    : [];
  if (entries.length > 0) {
    return entries;
  }
  return Array.isArray(agents.list)
    ? agents.list.flatMap((value, index) => {
        if (!isRecord(value)) {
          return [];
        }
        return [
          {
            agentId:
              typeof value.id === "string" && value.id.trim() !== ""
                ? value.id.trim()
                : `agent-${index}`,
            container: "list" as const,
            pathId: String(index),
            value,
          },
        ];
      })
    : [];
}

/** Path segment for a configured agent: `#0` for legacy list indexes, escaped key for entries. */
export function policyAgentPathSegment(agent: PolicyConfiguredAgent): string {
  return agent.container === "list" ? `#${agent.pathId}` : ocPathSegment(agent.pathId);
}
