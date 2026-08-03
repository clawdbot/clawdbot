import { formatErrorMessage } from "@openclaw/normalization-core";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { loadSkillStatusReport } from "../../lib/skills/index.ts";
import type { SkillsRouteData } from "./skills-page.ts";

async function loadSkillsRouteData(context: ApplicationContext): Promise<SkillsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const agents = context.agents;
  const client = gatewaySnapshot.client;
  if (gatewaySnapshot.phase !== "connected" || !client) {
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
    error = formatErrorMessage(err, { redact: redactToolDetail });
  }
  try {
    report = (await loadSkillStatusReport(client, null)) ?? null;
  } catch (err) {
    error ??= formatErrorMessage(err, { redact: redactToolDetail });
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
  ...routePageSpec("skills"),
  loader: loadSkillsRouteData,
  component: () =>
    import("./skills-page.ts").then(() => ({
      header: true,
      render: (data: SkillsRouteData | undefined) =>
        html`<openclaw-skills-page .routeData=${data}></openclaw-skills-page>`,
    })),
});
