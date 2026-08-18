import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type {
  CatalogSessionContinuedDetail,
  CatalogSessionKey,
} from "../lib/sessions/catalog-key.ts";

export function formatSidebarTimestamp(timestampMs: number | null | undefined): string {
  const now = Date.now();
  if (
    timestampMs != null &&
    Number.isFinite(timestampMs) &&
    timestampMs <= now &&
    now - timestampMs < 60_000
  ) {
    return t("common.now");
  }
  return formatRelativeTimestamp(timestampMs, {
    fallback: "",
    suffix: timestampMs != null && timestampMs > now,
  });
}

/** Session keys already adopted into OpenClaw sessions; the regular list hides
    these so each adopted session stays a single selectable catalog row. */
export function adoptedCatalogSessionKeys(catalogs: readonly SessionCatalog[]): Set<string> {
  const keys = new Set<string>();
  for (const catalog of catalogs) {
    for (const host of catalog.hosts) {
      for (const session of host.sessions) {
        if (session.sessionKey) {
          keys.add(session.sessionKey);
        }
      }
    }
  }
  return keys;
}

/** Catalogs the sidebar actually renders. Adopted-key exclusion must read this
    same projection: excluding a key whose catalog is hidden (or whose section
    the archived filter suppresses) deletes the session from the entire sidebar
    with no row anywhere. */
export function visibleSessionCatalogProjection(
  catalogs: readonly SessionCatalog[],
  hiddenCatalogIds: ReadonlySet<string>,
  archivedFilter: boolean,
): SessionCatalog[] {
  return archivedFilter ? [] : catalogs.filter((catalog) => !hiddenCatalogIds.has(catalog.id));
}

export function visibleCatalogHosts(
  hosts: readonly SessionCatalogHost[],
  ownerId?: string | null,
  liveOwnerIdBySessionKey: ReadonlyMap<string, string | undefined> = new Map(),
): SessionCatalogHost[] {
  const visible: SessionCatalogHost[] = [];
  for (const host of hosts) {
    const sessions = host.sessions.filter((session) => {
      if (!ownerId) {
        return true;
      }
      const sessionKey = session.sessionKey;
      const adopted = Boolean(sessionKey && liveOwnerIdBySessionKey.has(sessionKey));
      const effectiveOwnerId =
        adopted && sessionKey ? liveOwnerIdBySessionKey.get(sessionKey) : session.createdActor?.id;
      return effectiveOwnerId === ownerId;
    });
    if (sessions.length > 0) {
      visible.push(sessions.length === host.sessions.length ? host : { ...host, sessions });
    }
  }
  return visible;
}

export type CatalogBackingSessionDisplay = {
  label: string;
  subtitle?: string;
  pullRequest?: SessionCatalogSession["pullRequest"];
};

export type CatalogSessionMenuRequest = {
  key: CatalogSessionKey;
  agentId: string;
  routeId: "chat" | "new-session";
  navigation: ApplicationNavigationOptions;
  canOpenTerminal: boolean;
  meta: string;
};

/** Stamps a freshly adopted session key onto its catalog row so the sidebar
    binds it before the next catalog poll confirms the adoption. */
export function bindAdoptedCatalogSession(
  catalogs: readonly SessionCatalog[],
  detail: CatalogSessionContinuedDetail,
): SessionCatalog[] {
  return catalogs.map((catalog) =>
    catalog.id === detail.catalogId
      ? {
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            host.hostId === detail.hostId
              ? {
                  ...host,
                  sessions: host.sessions.map((session) =>
                    session.threadId === detail.threadId
                      ? { ...session, sessionKey: detail.sessionKey }
                      : session,
                  ),
                }
              : host,
          ),
        }
      : catalog,
  );
}
