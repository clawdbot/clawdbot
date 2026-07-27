import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { consumeCachedModelSetupDetection } from "./detect-cache.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";
import { detectModelSetup } from "./rpc.ts";

async function loadModelSetupRouteData(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<ModelSetupRouteData> {
  const firstRun = new URLSearchParams(location.search).get("firstRun") === "1";
  const snapshot = context.gateway.snapshot;
  const client = snapshot.phase === "connected" ? snapshot.client : null;
  if (
    !client ||
    !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
    isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true
  ) {
    return { state: { phase: "loading" }, client, firstRun };
  }
  const cached = consumeCachedModelSetupDetection(client);
  if (cached) {
    return { state: { phase: "ready", result: cached }, client, firstRun };
  }
  try {
    return {
      state: { phase: "ready", result: await detectModelSetup(client) },
      client,
      firstRun,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : t("modelSetup.errors.requestFailed");
    return { state: { phase: "detect-error", message }, client, firstRun };
  }
}

export const page = definePage({
  id: "model-setup",
  path: "/settings/model-setup",
  aliases: ["/model-setup"],
  // Query-only first-run changes need distinct matches so the completion
  // action cannot retain a cached destination from the previous visit.
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: async (context: ApplicationContext, { location }) =>
    loadModelSetupRouteData(context, location),
  component: () =>
    import("./model-setup-page.ts").then(() => ({
      header: true,
      render: (data: ModelSetupRouteData | undefined) =>
        html`<openclaw-model-setup-page .routeData=${data}></openclaw-model-setup-page>`,
    })),
});
