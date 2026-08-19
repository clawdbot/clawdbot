import {
  buildControlUiCatalogSharePath,
  isControlUiCatalogShareId,
  matchControlUiCatalogSharePath,
} from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import type { ChatRouteData } from "./session-route-data.ts";

function targetFromLocation(context: ApplicationContext, location: RouteLocation) {
  const matchPath = (pathname: string) =>
    matchControlUiCatalogSharePath({ pathname, basePath: context.basePath });
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  return (internalPath ? matchPath(internalPath) : null) ?? matchPath(location.pathname);
}

function routeError(message: string): Extract<ChatRouteData, { kind: "route-error" }> {
  return { kind: "route-error", message, face: "chat" };
}

export async function loadCatalogShareRouteFromLocation(
  context: ApplicationContext,
  location: RouteLocation,
  signal: AbortSignal,
): Promise<ChatRouteData | null> {
  const target = targetFromLocation(context, location);
  if (!target) {
    return null;
  }
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
      return routeError(
        t("chat.sessionRoute.catalogShareNotFound", {
          catalog: catalog.label,
          shortId: target.shortId,
        }),
      );
    }
    const session = matches[0];
    if (!session) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    if (
      !buildControlUiCatalogSharePath({
        shareRoute,
        threadId: session.threadId,
        prefixLength: shareRoute.fullLength,
      })
    ) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    return {
      kind: "session",
      sessionKey: buildCatalogSessionKey({
        catalogId: catalog.id,
        hostId: shareRoute.hostId,
        threadId: session.threadId,
      }),
      agentId,
      draft: undefined,
      face: "chat",
    };
  } catch (error) {
    signal.throwIfAborted();
    return routeError(formatUiError(error, t("chat.sessionRoute.catalogShareUnavailable")));
  }
}
