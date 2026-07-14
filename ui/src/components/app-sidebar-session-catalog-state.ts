import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError } from "../api/gateway.ts";

type SessionCatalogError = NonNullable<SessionCatalog["error"]>;

export function sessionCatalogRequestError(error: unknown): SessionCatalogError {
  return {
    code: error instanceof GatewayRequestError ? error.gatewayCode : "UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function mergeCatalogSessionRows(
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
