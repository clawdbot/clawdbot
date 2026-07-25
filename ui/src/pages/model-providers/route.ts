import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { ModelProvidersRouteData } from "./model-providers-page.ts";

async function loadModelProvidersRouteData(
  context: ApplicationContext,
): Promise<ModelProvidersRouteData> {
  const gatewaySnapshot = context.gateway.snapshot;
  const { EMPTY_MODEL_PROVIDERS_DATA, loadModelProvidersData } = await import("./load.ts");
  const client = gatewaySnapshot.phase === "connected" ? gatewaySnapshot.client : null;
  const agentsList =
    context.agents.state.agentsList ?? (client ? await context.agents.ensureList() : null);
  const requestedAgentId = context.agentSelection.state.scopeId;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : null;
  const rosterIds = new Set(agentsList?.agents.map((agent) => normalizeAgentId(agent.id)) ?? []);
  const agentId =
    normalizedRequested && rosterIds.has(normalizedRequested)
      ? normalizedRequested
      : normalizeAgentId(agentsList?.defaultId ?? agentsList?.agents[0]?.id ?? "main");
  if (!client) {
    return { data: EMPTY_MODEL_PROVIDERS_DATA, client: null, agentId };
  }
  return { data: await loadModelProvidersData(client, { agentId }), client, agentId };
}

export const page = definePage({
  id: "model-providers",
  path: "/settings/model-providers",
  aliases: ["/model-providers"],
  loader: loadModelProvidersRouteData,
  component: () =>
    import("./model-providers-page.ts").then(() => ({
      header: true,
      render: (data: ModelProvidersRouteData | undefined) =>
        html`<openclaw-model-providers-page .routeData=${data}></openclaw-model-providers-page>`,
    })),
});
