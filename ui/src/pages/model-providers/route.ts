import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelProvidersRouteData } from "./model-providers-page.ts";

async function loadModelProvidersRouteData(
  context: ApplicationContext,
): Promise<ModelProvidersRouteData> {
  const gatewaySnapshot = context.gateway.snapshot;
  const { EMPTY_MODEL_PROVIDERS_DATA, loadModelProvidersData } = await import("./load.ts");
  const client = gatewaySnapshot.phase === "connected" ? gatewaySnapshot.client : null;
  if (!context.agentSelection.modelOwnerId && client) {
    await context.agents.ensureList();
  }
  const agentId = context.agentSelection.modelOwnerId;
  if (!client || !agentId) {
    return { data: EMPTY_MODEL_PROVIDERS_DATA, client: null, agentId };
  }
  return { data: await loadModelProvidersData(client, { agentId }), client, agentId };
}

export const page = definePage({
  ...routePageSpec("model-providers"),
  loader: loadModelProvidersRouteData,
  component: () =>
    import("./model-providers-page.ts").then(() => ({
      header: true,
      render: (data: ModelProvidersRouteData | undefined) =>
        html`<openclaw-model-providers-page .routeData=${data}></openclaw-model-providers-page>`,
    })),
});
