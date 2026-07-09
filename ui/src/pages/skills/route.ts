import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSkillStatusReport } from "../../lib/skills/index.ts";
import type { SkillsRouteData } from "./skills-page.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSkillsRouteData(context: ApplicationContext): Promise<SkillsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const agents = context.agents;
  const client = gatewaySnapshot.client;
  if (!gatewaySnapshot.connected || !client) {
    return {
      gateway,
      gatewaySnapshot,
      agents,
      agentsList: null,
      selectedAgentId: null,
      report: null,
      error: null,
    };
  }

  let error: string | null = null;
  let agentsList: SkillsRouteData["agentsList"] = null;
  let report: SkillsRouteData["report"] = null;
  try {
    agentsList = await agents.ensureList();
  } catch (err) {
    error = errorMessage(err);
  }
  try {
    report = (await loadSkillStatusReport(client, null)) ?? null;
  } catch (err) {
    error ??= errorMessage(err);
  }
  return {
    gateway,
    gatewaySnapshot,
    agents,
    agentsList,
    selectedAgentId: null,
    report,
    error,
  };
}

export const page = definePage({
  id: "skills",
  path: "/skills",
  loader: loadSkillsRouteData,
  component: () =>
    import("./skills-page.ts").then(() => ({
      header: true,
      render: (data: SkillsRouteData | undefined) =>
        html`<openclaw-skills-page .routeData=${data}></openclaw-skills-page>`,
    })),
});
