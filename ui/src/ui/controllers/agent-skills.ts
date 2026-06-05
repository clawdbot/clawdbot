// Control UI controller manages agent skills gateway state.
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillStatusReport } from "../types.ts";

export type AgentSkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
};

export async function loadAgentSkills(state: AgentSkillsState, agentId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.agentSkillsLoading) {
    return;
  }
  state.agentSkillsLoading = true;
  state.agentSkillsError = null;
  try {
    const res = await state.client.request("skills.status", { agentId });
    if (res) {
      state.agentSkillsReport = res as SkillStatusReport;
      state.agentSkillsAgentId = agentId;
    }
  } catch (err) {
    state.agentSkillsError = String(err);
  } finally {
    state.agentSkillsLoading = false;
  }
}
