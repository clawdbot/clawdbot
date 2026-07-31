import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

type SessionCatalogError = NonNullable<SessionCatalog["error"]>;

export function sessionCatalogRequestError(error: unknown): SessionCatalogError {
  return {
    code: error instanceof GatewayRequestError ? error.gatewayCode : "UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  };
}

function mergeCatalogSessionRows(
  first: readonly SessionCatalogSession[],
  second: readonly SessionCatalogSession[],
): SessionCatalogSession[] {
  const seen = new Set(first.map((session) => session.threadId));
  return [...first, ...second.filter((session) => !seen.has(session.threadId))];
}

export function preserveExpandedCatalogHost(
  freshHost: SessionCatalogHost,
  previous: SessionCatalogHost | undefined,
): SessionCatalogHost {
  if (!previous) {
    return freshHost;
  }
  const { sessions, nextCursor, ...previousDetails } = previous;
  const { sessions: _freshSessions, nextCursor: _freshNextCursor, ...freshDetails } = freshHost;
  return {
    ...previousDetails,
    ...freshDetails,
    sessions,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export function mergeSessionCatalogPage(params: {
  current: SessionCatalog;
  page: SessionCatalog;
  cursors: Readonly<Record<string, string>>;
}): { catalog: SessionCatalog; advancedHostIds: string[] } {
  const pageHosts = new Map(params.page.hosts.map((host) => [host.hostId, host]));
  const advancedHostIds: string[] = [];
  const hosts = params.current.hosts.map((host) => {
    const requestedCursor = params.cursors[host.hostId];
    const pageHost = pageHosts.get(host.hostId);
    if (requestedCursor === undefined || host.nextCursor !== requestedCursor || !pageHost) {
      return host;
    }
    if (pageHost.error) {
      return preserveExpandedCatalogHost(pageHost, host);
    }
    advancedHostIds.push(host.hostId);
    const { nextCursor, sessions, error: _pageError, ...pageHostDetails } = pageHost;
    const { nextCursor: _currentCursor, error: _currentError, ...currentHost } = host;
    return {
      ...currentHost,
      ...pageHostDetails,
      sessions: mergeCatalogSessionRows(host.sessions, sessions),
      ...(nextCursor ? { nextCursor } : {}),
    };
  });
  const { hosts: _currentHosts, error: _currentError, ...currentDetails } = params.current;
  const { hosts: _pageHosts, error: pageError, ...pageDetails } = params.page;
  return {
    catalog: {
      ...currentDetails,
      ...pageDetails,
      hosts,
      ...(pageError ? { error: pageError } : {}),
    },
    advancedHostIds,
  };
}

export async function refetchExpandedSessionCatalogPages(params: {
  catalogs: SessionCatalog[];
  previousCatalogs: readonly SessionCatalog[];
  client: GatewayBrowserClient;
  agentId: string;
  pageDepths: ReadonlyMap<string, number>;
  isCurrent: () => boolean;
}): Promise<SessionCatalog[]> {
  const previousCatalogs = new Map(params.previousCatalogs.map((catalog) => [catalog.id, catalog]));
  return Promise.all(
    params.catalogs.map(async (catalog) => {
      const previousHosts = new Map(
        previousCatalogs.get(catalog.id)?.hosts.map((host) => [host.hostId, host]) ?? [],
      );
      const hosts = await Promise.all(
        catalog.hosts.map(async (host) => {
          const pageDepth =
            params.pageDepths.get(sessionCatalogHostKey(catalog.id, host.hostId)) ?? 0;
          if (pageDepth === 0) {
            return host;
          }
          const previous = previousHosts.get(host.hostId);
          if (host.error) {
            return preserveExpandedCatalogHost(host, previous);
          }
          let sessions = host.sessions;
          let nextCursor = host.nextCursor;
          for (let loadedPages = 0; loadedPages < pageDepth && nextCursor; loadedPages += 1) {
            let result: SessionsCatalogListResult;
            try {
              result = await params.client.request<SessionsCatalogListResult>(
                "sessions.catalog.list",
                {
                  agentId: params.agentId,
                  catalogId: catalog.id,
                  cursors: { [host.hostId]: nextCursor },
                },
              );
            } catch {
              return previous ?? host;
            }
            if (!params.isCurrent()) {
              return previous ?? host;
            }
            const pageHost = result.catalogs
              .find((candidate) => candidate.id === catalog.id)
              ?.hosts.find((candidate) => candidate.hostId === host.hostId);
            if (!pageHost) {
              return previous ?? host;
            }
            if (pageHost.error) {
              return preserveExpandedCatalogHost({ ...host, ...pageHost }, previous ?? host);
            }
            sessions = mergeCatalogSessionRows(sessions, pageHost.sessions);
            nextCursor = pageHost.nextCursor;
          }
          const { nextCursor: _cursor, sessions: _sessions, ...freshHost } = host;
          return { ...freshHost, sessions, ...(nextCursor ? { nextCursor } : {}) };
        }),
      );
      return { ...catalog, hosts };
    }),
  );
}
