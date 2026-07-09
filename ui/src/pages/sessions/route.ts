import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { SessionsRouteData } from "./sessions-page.ts";

function routeOptions(location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const expandedSessionKey = search.get("session")?.trim() || null;
  const showArchived = ["1", "true"].includes(search.get("showArchived")?.toLowerCase() ?? "");
  return { expandedSessionKey, showArchived };
}

async function loadSessionsRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<SessionsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const options = routeOptions(location);
  const checkpointAgentId = parseAgentSessionKey(options.expandedSessionKey)?.agentId;
  const [sessions] = await Promise.all([
    context.sessions
      .list({
        activeMinutes: options.expandedSessionKey || options.showArchived ? 0 : 60,
        limit: 50,
        search: options.expandedSessionKey ?? undefined,
        includeGlobal: true,
        includeUnknown: Boolean(options.expandedSessionKey),
        showArchived: options.showArchived,
        ...(checkpointAgentId ? { agentId: checkpointAgentId } : {}),
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
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
    const options = routeOptions(location);
    return `${options.expandedSessionKey ?? ""}\u0000${options.showArchived ? "1" : "0"}`;
  },
  loader: (context: ApplicationContext, { location }) => loadSessionsRoute(context, location),
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: (data: SessionsRouteData | undefined) =>
        html`<openclaw-sessions-page .routeData=${data}></openclaw-sessions-page>`,
    })),
});
