import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  type SessionArchivedFilter,
  type SessionListOptions,
  type SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

export type SessionsRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationContext["gateway"]["snapshot"];
  sessions: ApplicationContext["sessions"];
  result: SessionListSnapshot["result"];
  loading: boolean;
  error: string | null;
  expandedSessionKey: string | null;
  statusFilter: SessionArchivedFilter;
};

type SessionsPageListFilters = {
  activeMinutes?: number;
  limit?: number;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  deepLinkSessionKey?: string | null;
};

function routeOptions(location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const expandedSessionKey = search.get("session")?.trim() || null;
  // The retired internal `showArchived` param is deliberately not read; Sessions
  // URLs are not a shipped contract and stale links fall back to the Active view.
  const requestedStatus = search.get("status");
  const statusFilter: SessionArchivedFilter =
    requestedStatus === "archived" ? "archived" : requestedStatus === "all" ? "all" : "active";
  return { expandedSessionKey, statusFilter };
}

export function sessionsPageListQuery(
  context: ApplicationContext,
  filters: SessionsPageListFilters,
): SessionListOptions {
  const deepLinkSessionKey = filters.deepLinkSessionKey?.trim() || null;
  const scopeAgentId =
    parseAgentSessionKey(deepLinkSessionKey)?.agentId ??
    context.agentSelection.state.scopeId?.trim();
  const activeMinutes =
    !deepLinkSessionKey && filters.statusFilter === "active" ? filters.activeMinutes : undefined;
  return {
    limit: deepLinkSessionKey ? DEFAULT_SESSION_LIST_QUERY.limit : filters.limit,
    ...(activeMinutes ? { activeMinutes } : {}),
    ...(deepLinkSessionKey ? { search: deepLinkSessionKey } : {}),
    includeGlobal: deepLinkSessionKey ? true : filters.includeGlobal,
    includeUnknown: deepLinkSessionKey ? true : filters.includeUnknown,
    includeDerivedTitles: false,
    includeLastMessage: false,
    archivedFilter: filters.statusFilter,
    ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
  };
}

async function loadSessionsRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<SessionsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const sessions = context.sessions;
  const options = routeOptions(location);
  const query = sessionsPageListQuery(context, {
    limit: DEFAULT_SESSION_LIST_QUERY.limit,
    includeGlobal: true,
    includeUnknown: false,
    statusFilter: options.statusFilter,
    deepLinkSessionKey: options.expandedSessionKey,
  });
  let snapshot = sessions.listSnapshot(query);
  await Promise.all([
    !snapshot.result && !snapshot.loading
      ? sessions.refreshList({ ...query, force: true })
      : undefined,
    context.runtimeConfig.ensureLoaded().catch(() => undefined),
  ]);
  snapshot = sessions.listSnapshot(query);
  return {
    gateway,
    gatewaySnapshot,
    sessions,
    result: snapshot.result,
    loading: snapshot.loading,
    error: snapshot.error,
    ...options,
  };
}

export const page = definePage({
  ...routePageSpec("sessions"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const options = routeOptions(location);
    return `${options.expandedSessionKey ?? ""}\u0000${options.statusFilter}\u0000${context.agentSelection.state.scopeId ?? "all"}`;
  },
  loader: (context: ApplicationContext, { location }) => loadSessionsRoute(context, location),
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: (data: SessionsRouteData | undefined) =>
        html`<openclaw-sessions-page .routeData=${data}></openclaw-sessions-page>`,
    })),
});
