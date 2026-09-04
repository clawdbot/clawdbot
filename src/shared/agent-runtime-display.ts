import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function formatAgentRuntimeLabel(agentRuntime?: { id?: string; fallback?: string }): string {
  const id = normalizeOptionalString(agentRuntime?.id) ?? "pi";
  const fallback = normalizeOptionalString(agentRuntime?.fallback);
  return fallback ? `${id} (fallback ${fallback})` : id;
}
