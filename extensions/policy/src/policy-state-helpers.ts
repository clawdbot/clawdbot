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

export function collectPolicyConfiguredAgents(agents: Record<string, unknown>) {
  const entries = agents.entries;
  if (Object.hasOwn(agents, "entries") && entries !== undefined) {
    return isRecord(entries)
      ? Object.entries(entries)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([agentId, value]) => ({
            agentId,
            sourceBase: `oc://openclaw.config/agents/entries/${ocPathSegment(agentId)}`,
            value,
          }))
      : [];
  }
  return Array.isArray(agents.list)
    ? agents.list.map((value, index) => ({
        agentId:
          isRecord(value) && typeof value.id === "string" && value.id.trim() !== ""
            ? value.id.trim()
            : `agent-${index}`,
        sourceBase: `oc://openclaw.config/agents/list/#${index}`,
        value,
      }))
    : [];
}
