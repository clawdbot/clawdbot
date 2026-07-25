import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type CatalogSessionKey = {
  catalogId: string;
  hostId: string;
  threadId: string;
};

/** Fired on `document` when a catalog session is adopted into an OpenClaw
    session, so the sidebar can bind the row to its session key immediately
    instead of waiting for the next catalog poll. */
export const CATALOG_SESSION_CONTINUED_EVENT = "openclaw-session-catalog-continued";

export type CatalogSessionContinuedDetail = CatalogSessionKey & { sessionKey: string };

export function announceCatalogSessionContinued(detail: CatalogSessionContinuedDetail): void {
  document.dispatchEvent(
    new CustomEvent<CatalogSessionContinuedDetail>(CATALOG_SESSION_CONTINUED_EVENT, { detail }),
  );
}

const CATALOG_SESSION_LOOKUP_PAGE_LIMIT = 100;
const CATALOG_SESSION_LOOKUP_MAX_PAGES = 100;

type CatalogSessionLookup = {
  host: SessionCatalogHost | null;
  session: SessionCatalogSession | null;
};

/** Resolves a catalog row's metadata (host + per-session capability flags).
    A sidebar row can come from any loaded page, so this follows the host's
    cursor until the thread is found; `null` means the caller went stale. */
export async function lookupCatalogSession(params: {
  client: Pick<GatewayBrowserClient, "request">;
  key: CatalogSessionKey;
  isCurrent: () => boolean;
}): Promise<CatalogSessionLookup | null> {
  const { client, key } = params;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let host: SessionCatalogHost | null = null;
  for (let pageIndex = 0; pageIndex < CATALOG_SESSION_LOOKUP_MAX_PAGES; pageIndex += 1) {
    const listed = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      catalogId: key.catalogId,
      hostIds: [key.hostId],
      limitPerHost: CATALOG_SESSION_LOOKUP_PAGE_LIMIT,
      ...(cursor ? { cursors: { [key.hostId]: cursor } } : {}),
    });
    if (!params.isCurrent()) {
      return null;
    }
    const catalog = listed.catalogs.find((candidate) => candidate.id === key.catalogId);
    host = catalog?.hosts.find((candidate) => candidate.hostId === key.hostId) ?? null;
    const session = host?.sessions.find((candidate) => candidate.threadId === key.threadId) ?? null;
    if (session) {
      return { host, session };
    }
    const nextCursor = host?.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { host, session: null };
}

export function buildCatalogSessionKey(key: CatalogSessionKey): string {
  return `catalog:${encodeURIComponent(key.catalogId)}:${encodeURIComponent(key.hostId)}:${encodeURIComponent(key.threadId)}`;
}

export function parseCatalogSessionKey(value: string | null | undefined): CatalogSessionKey | null {
  if (!value?.startsWith("catalog:")) {
    return null;
  }
  const parts = value.slice("catalog:".length).split(":");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return null;
  }
  try {
    const [catalogId, hostId, threadId] = parts.map((part) => decodeURIComponent(part));
    return catalogId && hostId && threadId ? { catalogId, hostId, threadId } : null;
  } catch {
    return null;
  }
}
