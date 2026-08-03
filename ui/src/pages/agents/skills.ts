// Control UI controller manages agent skills gateway state.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import { loadSkillStatusReport } from "../../lib/skills/index.ts";

type AgentSkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
};

export async function loadAgentSkills(state: AgentSkillsState, agentId: string) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.agentSkillsLoading) {
    return;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  state.agentSkillsLoading = true;
  state.agentSkillsError = null;
  try {
    const res = await loadSkillStatusReport(client, agentId);
    if (res && isCurrent()) {
      state.agentSkillsReport = res;
      state.agentSkillsAgentId = agentId;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentSkillsError = String(err);
    }
  } finally {
    if (isCurrent()) {
      state.agentSkillsLoading = false;
    }
  }
}
