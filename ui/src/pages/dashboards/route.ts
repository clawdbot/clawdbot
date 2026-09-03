import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  type SessionListOptions,
  type SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";
import type { DashboardsRouteData } from "./view.ts";

export function dashboardSessionListQuery(context: ApplicationContext): SessionListOptions {
  return {
    ...DEFAULT_SESSION_LIST_QUERY,
    boardFace: "dashboard",
    archivedFilter: "all",
    ...(context.agentSelection.state.scopeId
      ? { agentId: context.agentSelection.state.scopeId }
      : {}),
  };
}

export function dashboardsRouteData(
  context: ApplicationContext,
  snapshot: SessionListSnapshot,
): DashboardsRouteData {
  return {
    result: snapshot.result,
    error: snapshot.error,
    basePath: context.basePath,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  };
}

async function loadDashboardsRoute(context: ApplicationContext): Promise<DashboardsRouteData> {
  const query = dashboardSessionListQuery(context);
  let snapshot = context.sessions.listSnapshot(query);
  if (!snapshot.result && !snapshot.loading) {
    await context.sessions.refreshList({ ...query, force: true });
    snapshot = context.sessions.listSnapshot(query);
  }
  return dashboardsRouteData(context, snapshot);
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
