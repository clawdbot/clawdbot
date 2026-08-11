import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { DEFAULT_SESSION_LIST_QUERY } from "../../lib/sessions/index.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import type { DashboardsRouteData } from "./view.ts";

export async function loadDashboardsRoute(
  context: ApplicationContext,
): Promise<DashboardsRouteData> {
  let value = null;
  let error: string | null = null;
  try {
    value = await context.sessions.list({
      ...DEFAULT_SESSION_LIST_QUERY,
      boardFace: "dashboard",
      archivedFilter: "all",
      ...(context.agentSelection.state.scopeId
        ? { agentId: context.agentSelection.state.scopeId }
        : {}),
    });
  } catch (cause) {
    error = String(cause);
  }
  return {
    result: value,
    error,
    basePath: context.basePath,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  };
}

export const page = definePage({
  ...routePageSpec("dashboards"),
  loader: loadDashboardsRoute,
  component: () =>
    import("./dashboards-page.ts").then(() => ({
      header: true,
      render: (data: DashboardsRouteData | undefined) =>
        html`<openclaw-dashboards-page .routeData=${data}></openclaw-dashboards-page>`,
    })),
});
