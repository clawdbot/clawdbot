import type { RouteLocation } from "@openclaw/uirouter";
import type { SessionsResolveResult } from "../../../packages/gateway-protocol/src/index.js";
import type { AgentsListResult } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { routeIdFromPath } from "../app-routes.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { parseCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import type { ApplicationGateway } from "./context.ts";
import { waitForGatewayClient } from "./gateway-readiness.ts";

type ReleasedSessionQuery = {
  face: BoardFace;
  sessionKey: string;
};

// Saved selection only fills an implicit landing. Agent paths remain explicit,
// even when first-run setup is eligible to run on that same path.
function isPersistedSessionLanding(location: RouteLocation, basePath: string): boolean {
  return (
    !new URLSearchParams(location.search + "&" + location.hash.slice(1)).has("session") &&
    (routeIdFromPath(location.pathname, basePath) === null ||
      /^\/chat\/?$/u.test(location.pathname.slice(basePath.length)))
  );
}

function resolvePersistedAgentId(
  selectedAgentId: string | null | undefined,
  agentsList: AgentsListResult | null,
): string | null {
  const selectedId = selectedAgentId?.trim();
  if (!selectedId || !agentsList) {
    return null;
  }
  const normalizedId = normalizeAgentId(selectedId);
  return agentsList.agents.some((agent) => normalizeAgentId(agent.id) === normalizedId)
    ? normalizedId
    : null;
}

function releasedSessionQuery(
  location: RouteLocation,
  basePath: string,
): ReleasedSessionQuery | null {
  const params = new URLSearchParams(location.search);
  if (!params.has("session")) {
    return null;
  }
  const chatRoot = pathForRoute("chat", basePath);
  const dashboardRoot = pathForRoute("dashboard", basePath);
  const pathFace =
    location.pathname === chatRoot || location.pathname === `${chatRoot}/`
      ? "chat"
      : location.pathname === dashboardRoot || location.pathname === `${dashboardRoot}/`
        ? "dashboard"
        : null;
  if (!pathFace) {
    return null;
  }
  return {
    face: params.get("face") === "dashboard" ? "dashboard" : pathFace,
    sessionKey: params.get("session")?.trim() ?? "",
  };
}

async function normalizeReleasedSessionQueryLocation(params: {
  location: RouteLocation;
  basePath: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => AgentsListResult | null;
  selectedAgentId?: string | null;
  signal: AbortSignal;
}): Promise<RouteLocation | null> {
  const released = releasedSessionQuery(params.location, params.basePath);
  if (!released) {
    return null;
  }
  const defaultsKnown = Boolean(
    params.agentsList()?.mainKey?.trim() ||
    (params.gateway.snapshot.phase === "connected" && params.gateway.snapshot.hello),
  );
  const parsed = parseAgentSessionKey(released.sessionKey);
  if (released.sessionKey && !defaultsKnown) {
    await waitForGatewayClient(params.gateway, params.signal);
  }
  const defaults = {
    agentsList: params.agentsList(),
    hello: params.gateway.snapshot.hello,
  };
  const agentId =
    parsed?.agentId ??
    (resolvePersistedAgentId(params.selectedAgentId, defaults.agentsList) ||
      resolveUiDefaultAgentId(defaults));
  const mainKey = resolveUiConfiguredMainKey(defaults);
  const pathname = released.sessionKey
    ? pathForSession(released.face, agentId, released.sessionKey, params.basePath, {
        mainKey,
      })
    : null;
  const search = new URLSearchParams(params.location.search);
  search.delete("session");
  search.delete("face");
  const nextSearch = search.toString();
  return {
    ...params.location,
    pathname: pathname ?? pathForRoute(released.face, params.basePath),
    search: nextSearch ? `?${nextSearch}` : "",
  };
}

export function normalizeInitialApplicationLocation(
  location: RouteLocation,
  basePath: string,
  sessionKey: string,
  fallbackAgentId: string,
  mainKey?: string | null,
) {
  if (!isPersistedSessionLanding(location, basePath) || !sessionKey.trim()) {
    return location;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId.trim();
  if (!agentId) {
    return location;
  }
  const { options } = sessionNavigationTarget({
    face: "chat",
    sessionKey,
    fallbackAgentId: agentId,
    basePath,
    mainKey,
    exactKey: true,
  });
  if (options.pathname === pathForRoute("chat", basePath)) {
    return location;
  }
  const search = new URLSearchParams(location.search);
  new URLSearchParams(options.search).forEach((value, key) => search.set(key, value));
  return { ...location, pathname: options.pathname, search: search.size ? `?${search}` : "" };
}

export function createInitialApplicationLocationResolver(params: {
  fallback: RouteLocation;
  signal: AbortSignal;
  resolve: () => Promise<RouteLocation>;
}): () => Promise<RouteLocation> {
  let ready: Promise<RouteLocation> | null = null;
  return () =>
    (ready ??= params.resolve().catch((error: unknown) => {
      if (params.signal.aborted) {
        return params.fallback;
      }
      throw error;
    }));
}

export async function resolveInitialApplicationLocation(params: {
  location: RouteLocation;
  basePath: string;
  sessionKey: string;
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">;
  agentsList: () => AgentsListResult | null;
  ensureAgentsList?: () => Promise<AgentsListResult | null>;
  selectedAgentId?: string | null;
  signal: AbortSignal;
}): Promise<RouteLocation> {
  const releasedLocation = await normalizeReleasedSessionQueryLocation(params);
  if (releasedLocation) {
    return releasedLocation;
  }
  if (!isPersistedSessionLanding(params.location, params.basePath)) {
    return params.location;
  }
  const client = await waitForGatewayClient(params.gateway, params.signal);
  const hello = params.gateway.snapshot.hello;
  let agentsList = params.agentsList();
  const initialDefaults = {
    agentsList,
    hello: params.gateway.snapshot.hello,
  };
  let sessionKey = params.sessionKey.trim() || params.gateway.snapshot.sessionKey;
  let defaultAgentId = resolveUiDefaultAgentId(initialDefaults);
  let agentId =
    parseAgentSessionKey(sessionKey)?.agentId ??
    resolvePersistedAgentId(params.selectedAgentId, agentsList) ??
    defaultAgentId;

  agentsList = (await params.ensureAgentsList?.()) ?? agentsList;
  params.signal.throwIfAborted();
  if (params.gateway.snapshot.client !== client || params.gateway.snapshot.hello !== hello) {
    return resolveInitialApplicationLocation(params);
  }
  defaultAgentId = resolveUiDefaultAgentId({ agentsList, hello });
  if (agentsList && !resolvePersistedAgentId(agentId, agentsList)) {
    agentId = resolvePersistedAgentId(params.selectedAgentId, agentsList) ?? defaultAgentId;
    sessionKey = buildAgentMainSessionKey({
      agentId,
      mainKey: resolveUiConfiguredMainKey({ agentsList, hello: params.gateway.snapshot.hello }),
    });
  }

  const defaults = { agentsList, hello: params.gateway.snapshot.hello };
  const mainKey = resolveUiConfiguredMainKey(defaults);
  const identity = resolveUiConversationIdentity(defaults, sessionKey, agentId);
  sessionKey = identity.sessionKey;
  agentId = identity.agentId ?? agentId;
  const parsed = parseAgentSessionKey(sessionKey);
  const isMain =
    isUiGlobalSessionKey(sessionKey) ||
    (parsed?.rest ?? sessionKey).toLowerCase() === mainKey.toLowerCase();
  let resolved: SessionsResolveResult | null = null;
  if (!isMain && !parseCatalogSessionKey(sessionKey)) {
    try {
      resolved = await client.request<SessionsResolveResult>(
        "sessions.resolve",
        {
          key: sessionKey,
          agentId,
          allowMissing: true,
        },
        { signal: params.signal },
      );
    } catch {
      params.signal.throwIfAborted();
      // Validation is optional during a connection failure. The exact route below
      // preserves the saved identity without guessing from a shortened key.
    }
    params.signal.throwIfAborted();
    if (params.gateway.snapshot.client !== client || params.gateway.snapshot.hello !== hello) {
      // The response belongs to the captured Gateway generation. Re-entering
      // prevents a reconnect from installing state the replacement never confirmed.
      return resolveInitialApplicationLocation(params);
    }
    if (resolved && !resolved.ok) {
      sessionKey = buildAgentMainSessionKey({ agentId, mainKey });
    }
  }

  const row = resolved?.ok ? resolved : undefined;
  return normalizeInitialApplicationLocation(
    params.location,
    params.basePath,
    row?.key ?? sessionKey,
    row?.agentId ?? agentId,
    mainKey,
  );
}
