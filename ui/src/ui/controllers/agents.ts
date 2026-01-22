import type { GatewayBrowserClient } from "../gateway";
import type { AgentsListResult } from "../types";

export type AgentsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
};

export async function loadAgents(state: AgentsState) {
  if (!state.client || !state.connected) return;
  if (state.agentsLoading) return;
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = (await state.client.request("agents.list", {})) as AgentsListResult | undefined;
    if (res) state.agentsList = res;
  } catch (err) {
    state.agentsError = String(err);
  } finally {
    state.agentsLoading = false;
  }
}
