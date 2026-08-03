import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { DEFAULT_SESSION_LIST_QUERY } from "../../lib/sessions/index.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import type { DashboardsRouteData } from "./view.ts";

async function loadDashboardsRoute(context: ApplicationContext): Promise<DashboardsRouteData> {
  const result = await context.sessions
    .list({
      ...DEFAULT_SESSION_LIST_QUERY,
      boardFace: "dashboard",
      archivedFilter: "all",
      ...(context.agentSelection.state.scopeId
        ? { agentId: context.agentSelection.state.scopeId }
        : {}),
    })
    .then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error: String(error) }),
    );
  return {
    result: result.value,
    error: result.error,
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
  loaderDeps: (context: ApplicationContext) =>
    `${context.agentSelection.state.scopeId ?? "all"}\u0000${context.sessions.canonicalListRevision}`,
  loader: (context: ApplicationContext) => loadDashboardsRoute(context),
  component: () =>
    import("./view.ts").then(({ renderDashboards }) => ({
      header: true,
      render: (data: DashboardsRouteData | undefined) => html`${renderDashboards(data)}`,
    })),
});
