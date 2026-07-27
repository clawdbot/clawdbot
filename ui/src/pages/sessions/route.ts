import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  type SessionArchivedFilter,
} from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { SessionsRouteData } from "./sessions-page.ts";

function routeOptions(location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const expandedSessionKey = search.get("session")?.trim() || null;
  // The retired internal `showArchived` param is deliberately not read; dashboard
  // URLs are not a shipped contract and stale links fall back to the Active view.
  const requestedStatus = search.get("status");
  const statusFilter: SessionArchivedFilter =
    requestedStatus === "archived" ? "archived" : requestedStatus === "all" ? "all" : "active";
  return { expandedSessionKey, statusFilter };
}

async function loadSessionsRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<SessionsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const options = routeOptions(location);
  const checkpointAgentId = parseAgentSessionKey(options.expandedSessionKey)?.agentId;
  const scopeAgentId = checkpointAgentId ?? context.agentSelection.state.scopeId;
  const [sessions] = await Promise.all([
    context.sessions
      .list({
        ...DEFAULT_SESSION_LIST_QUERY,
        search: options.expandedSessionKey ?? undefined,
        includeGlobal: true,
        includeUnknown: Boolean(options.expandedSessionKey),
        archivedFilter: options.statusFilter,
        ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
      })
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error: String(error) }),
      ),
    context.runtimeConfig.ensureLoaded().catch(() => undefined),
  ]);
  return {
    gateway,
    gatewaySnapshot,
    result: sessions.result,
    error: sessions.error,
    ...options,
  };
}

export const page = definePage({
  id: "sessions",
  path: "/sessions",
  aliases: ["/settings/sessions"],
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
