import type { ApplicationContext } from "../../app/context.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

export type CustodianConfiguredInferenceState = "unresolved" | "required" | "ready";

export function resolveCustodianConfiguredInferenceState(
  context: ApplicationContext | null,
): CustodianConfiguredInferenceState {
  if (!context || context.gateway.snapshot.phase !== "connected") {
    return "unresolved";
  }
  const agentsList = context.agents.state.agentsList;
  if (!agentsList) {
    return "unresolved";
  }
  const selectedId = normalizeAgentId(
    context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
  );
  const selectedAgent = agentsList.agents.find(
    (agent) => normalizeAgentId(agent.id) === selectedId,
  );
  if (!selectedAgent) {
    return "unresolved";
  }
  return selectedAgent.model?.primary?.trim() ? "ready" : "required";
}
