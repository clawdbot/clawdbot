import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";

export async function loadSkillStatusReport(
  client: GatewayBrowserClient,
  agentId: string,
): Promise<SkillStatusReport | undefined> {
  return client.request<SkillStatusReport | undefined>("skills.status", { agentId });
}
