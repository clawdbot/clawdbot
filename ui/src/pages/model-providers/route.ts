import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { ModelProvidersRouteData } from "./model-providers-page.ts";

async function loadModelProvidersRouteData(
  context: ApplicationContext,
): Promise<ModelProvidersRouteData> {
  const gatewaySnapshot = context.gateway.snapshot;
  const { EMPTY_MODEL_PROVIDERS_DATA, loadModelProvidersData } = await import("./load.ts");
  const client = gatewaySnapshot.connected ? gatewaySnapshot.client : null;
  if (!client) {
    return { data: EMPTY_MODEL_PROVIDERS_DATA, client: null };
  }
  return { data: await loadModelProvidersData(client), client };
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
