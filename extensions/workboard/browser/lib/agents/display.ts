export function listSelectableAgents<T extends { kind?: "agent" | "system" }>(
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => agent.kind !== "system");
}
