import { matchControlUiCatalogSharePath } from "@openclaw/session-url-contract/parse";
import {
  buildControlUiCatalogSharePath,
  isControlUiCatalogShareId,
} from "@openclaw/session-url-contract/share-build";
import type { RouteLocation } from "@openclaw/uirouter";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import { missingSessionRouteData } from "./route-loader-session-reference.ts";
import type { ChatRouteData } from "./session-route-data.ts";

function targetFromLocation(context: ApplicationContext, location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const internalPath = search.get(INTERNAL_SESSION_PATH_PARAM);
  const pathname = internalPath || location.pathname;
  const target = matchControlUiCatalogSharePath({ pathname, basePath: context.basePath });
  if (!target || !internalPath) {
    return target ? { target, location } : null;
  }
  search.delete(INTERNAL_SESSION_PATH_PARAM);
  const serializedSearch = search.toString();
  return {
    target,
    location: { ...location, pathname, search: serializedSearch ? `?${serializedSearch}` : "" },
  };
}

function routeError(message: string): Extract<ChatRouteData, { kind: "route-error" }> {
  return { kind: "route-error", message, face: "chat" };
}

export async function loadCatalogShareRouteFromLocation(
  context: ApplicationContext,
  location: RouteLocation,
  signal: AbortSignal,
): Promise<ChatRouteData | null> {
  const resolved = targetFromLocation(context, location);
  if (!resolved) {
    return null;
  }
  const { target, location: sourceLocation } = resolved;
  try {
    const client = await waitForGatewayClient(context.gateway, signal);
    signal.throwIfAborted();
    const agentId = resolveUiDefaultAgentId({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    });
    const listed = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId,
      search: target.shortId,
      limitPerHost: 2,
    });
    signal.throwIfAborted();
    const matchingCatalogs = listed.catalogs.filter(
      (candidate) => candidate.shareRoute?.routeSegment === target.routeSegment,
    );
    const catalog = matchingCatalogs.length === 1 ? matchingCatalogs[0] : undefined;
    if (!catalog?.shareRoute) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    const shareRoute = catalog.shareRoute;
    if (!isControlUiCatalogShareId(shareRoute, target.shortId)) {
      return routeError(t("chat.sessionRoute.catalogShareInvalid", { catalog: catalog.label }));
    }
    if (catalog.error) {
      return routeError(catalog.error.message);
    }
    const matchingHosts = catalog.hosts.filter(
      (candidate) => candidate.hostId === shareRoute.hostId,
    );
    const host = matchingHosts.length === 1 ? matchingHosts[0] : undefined;
    if (!host) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    if (host?.error) {
      return routeError(host.error.message);
    }
    const matches = host.sessions.filter(
      (session) =>
        isControlUiCatalogShareId(shareRoute, session.threadId) &&
        session.threadId.length === shareRoute.fullLength &&
        session.threadId.startsWith(target.shortId),
    );
    if (matches.length > 1 || host.nextCursor) {
      const candidates = matches.flatMap((session) => {
        const href = buildControlUiCatalogSharePath({
          shareRoute,
          threadId: session.threadId,
          displayName: session.name,
          basePath: context.basePath,
          prefixLength: shareRoute.fullLength,
        });
        return href
          ? [
              {
                agentId: catalog.label,
                displayName: session.name?.trim() || session.threadId,
                href,
                idPrefix: session.threadId,
              },
            ]
          : [];
      });
      return {
        kind: "ambiguous",
        shortId: target.shortId,
        candidates,
        truncated: Boolean(host.nextCursor),
        face: "chat",
      };
    }
    if (matches.length === 0) {
      return missingSessionRouteData(context, "chat", agentId);
    }
    const session = matches[0];
    if (!session) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    const pathname = buildControlUiCatalogSharePath({
      shareRoute,
      threadId: session.threadId,
      displayName: session.name,
      basePath: context.basePath,
      prefixLength: target.shortId.length,
    });
    if (!pathname) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    return {
      kind: "session",
      sessionKey: buildCatalogSessionKey(
        { catalogId: catalog.id, hostId: shareRoute.hostId, threadId: session.threadId },
        agentId,
      ),
      agentId,
      draft: undefined,
      face: "chat",
      // Names can change on later uploads; the id resolves the same transcript.
      ...(pathname !== sourceLocation.pathname
        ? {
            canonicalLocation: { ...sourceLocation, pathname },
            canonicalLocationSource: sourceLocation,
          }
        : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    return routeError(formatUiError(error, t("chat.sessionRoute.catalogShareUnavailable")));
  }
}
