import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
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
  allowReconnectRetry = true,
): Promise<ModelSetupRouteData> {
  const firstRun = new URLSearchParams(location.search).get("firstRun") === "1";
  const snapshot = context.gateway.snapshot;
  const client = snapshot.phase === "connected" ? snapshot.client : null;
  const agentId = context.agentSelection.state.selectedId;
  const connection = { client, hello: snapshot.hello, agentId };
  if (
    !client ||
    !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
    isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true
  ) {
    return { state: { phase: "loading" }, connection, firstRun };
  }
  const cached = consumeCachedModelSetupDetection(connection);
  if (cached) {
    return { state: { phase: "ready", result: cached }, connection, firstRun };
  }
  let state: ModelSetupRouteData["state"];
  try {
    state = {
      phase: "ready",
      result: await detectModelSetup(client, agentId ?? undefined),
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : t("modelSetup.errors.requestFailed");
    state = { phase: "detect-error", message };
  }

  const current = context.gateway.snapshot;
  if (
    current.phase === "connected" &&
    current.client === connection.client &&
    current.hello === connection.hello &&
    context.agentSelection.state.selectedId === connection.agentId
  ) {
    return { state, connection, firstRun };
  }
  if (
    allowReconnectRetry &&
    current.phase === "connected" &&
    current.client &&
    hasOperatorAdminAccess(current.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(current, "openclaw.setup.detect") === true
  ) {
    return loadModelSetupRouteData(context, location, false);
  }
  // Keep the producer's stale generation so the mounted page owns a fresh
  // detection instead of accepting an unresolved current-generation result.
  return { state: { phase: "loading" }, connection, firstRun };
}

export const page = definePage({
  ...routePageSpec("model-setup"),
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
