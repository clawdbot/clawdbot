import type { RouteLocation, RouteMatch } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { INTERNAL_SESSION_PATH_PARAM, pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import { sessionRefFromPath } from "../../app-session-route-paths.ts";
import { resolveControlUiBasePath } from "../../app/browser.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../../lib/sessions/catalog-key.ts";
import {
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import type { ChatRouteData } from "./route-loader.ts";

type SessionOwnerMatch = Pick<RouteMatch, "data" | "location">;

function renderAmbiguous(data: Extract<ChatRouteData, { kind: "ambiguous" }>) {
  return html`
    <section class="card">
      <h2>${t("chat.sessionRoute.chooseTitle")}</h2>
      <p>
        ${data.candidates.length > 1
          ? t("chat.sessionRoute.multipleMatches", { shortId: data.shortId })
          : t("chat.sessionRoute.additionalMatches")}
      </p>
      ${data.candidates.map(
        (candidate) => html`
          <p>
            <a href=${candidate.href}>${candidate.displayName}</a><br />
            <small>${candidate.agentId} · ${candidate.idPrefix}</small>
          </p>
        `,
      )}
      ${data.truncated && data.candidates.length > 1
        ? html`<p><small>${t("chat.sessionRoute.additionalMatches")}</small></p>`
        : null}
    </section>
  `;
}

function sessionLoaderDeps(
  face: BoardFace,
  context: ApplicationContext,
  location: RouteLocation,
): string {
  const search = new URLSearchParams(location.search);
  const bridgedPath =
    location.pathname === pathForRoute(face, context.basePath)
      ? search.get(INTERNAL_SESSION_PATH_PARAM)
      : null;
  if (bridgedPath) {
    search.delete(INTERNAL_SESSION_PATH_PARAM);
  }
  const serializedSearch = search.toString();
  return `${bridgedPath ?? location.pathname}\u0000${
    serializedSearch ? `?${serializedSearch}` : ""
  }`;
}

function sessionOwnerKey(sessionKey: string): string {
  return `chat-session:${sessionKey}`;
}

function sessionTargetFromLocation(location: RouteLocation) {
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  const pathname = internalPath ?? location.pathname;
  return sessionRefFromPath(pathname, resolveControlUiBasePath(pathname));
}

function locationWithoutOwnerHints(location: RouteLocation): RouteLocation {
  const withoutDraft = locationWithoutDraft(location);
  const search = new URLSearchParams(withoutDraft.search);
  search.delete(SESSION_FACE_PREFERENCE_PARAM);
  search.delete(SESSION_NAVIGATION_KEY_PARAM);
  const serialized = search.toString();
  return { ...withoutDraft, search: serialized ? `?${serialized}` : "" };
}

function routeLocationsEqual(left: RouteLocation, right: RouteLocation): boolean {
  return (
    left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  );
}

function sessionTargetsEqual(
  left: ReturnType<typeof sessionTargetFromLocation>,
  right: ReturnType<typeof sessionTargetFromLocation>,
): boolean {
  if (!left || !right || left.agentId !== right.agentId || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "main" && right.kind === "main") {
    return true;
  }
  if (left.kind === "literal" && right.kind === "literal") {
    return left.sessionKey === right.sessionKey && left.slugCandidate === right.slugCandidate;
  }
  return (
    left.kind === "short" &&
    right.kind === "short" &&
    left.shortId === right.shortId &&
    left.slugHint === right.slugHint
  );
}

function settledSessionOwnerKey(
  pending: SessionOwnerMatch,
  settled: SessionOwnerMatch | undefined,
): string | undefined {
  const settledData = settled?.data as ChatRouteData | undefined;
  if (!settled || settledData?.kind !== "session") {
    return undefined;
  }
  const canonical = settledData.canonicalLocation;
  if (
    canonical &&
    routeLocationsEqual(
      locationWithoutOwnerHints(pending.location),
      locationWithoutOwnerHints(canonical),
    )
  ) {
    return sessionOwnerKey(settledData.sessionKey);
  }
  return sessionTargetsEqual(
    sessionTargetFromLocation(pending.location),
    sessionTargetFromLocation(settled.location),
  )
    ? sessionOwnerKey(settledData.sessionKey)
    : undefined;
}

function sessionRenderOwnerKey(
  face: BoardFace,
  match: SessionOwnerMatch,
  settled: SessionOwnerMatch | undefined,
): string | undefined {
  const data = match.data as ChatRouteData | undefined;
  if (data?.kind === "ambiguous") {
    return undefined;
  }
  if (data?.kind === "session") {
    return sessionOwnerKey(data.sessionKey);
  }
  const search = new URLSearchParams(match.location.search);
  const catalogKey = catalogSessionKeyFromSearch(match.location.search);
  if (catalogKey) {
    return sessionOwnerKey(buildCatalogSessionKey(catalogKey));
  }
  const navigationKey = search.get(SESSION_NAVIGATION_KEY_PARAM)?.trim();
  if (navigationKey) {
    return sessionOwnerKey(navigationKey);
  }
  const target = sessionTargetFromLocation(match.location);
  if (target?.namespace !== face) {
    return undefined;
  }
  if (target.kind === "literal" && target.slugCandidate === undefined) {
    return sessionOwnerKey(target.sessionKey);
  }
  // Unresolved short and slug routes borrow identity only from the exact route
  // that settled them; path resemblance alone cannot identify a session.
  return settledSessionOwnerKey(match, settled);
}

function sessionPage(face: BoardFace) {
  return definePage({
    ...routePageSpec(face),
    // The application router temporarily maps dynamic session URLs onto the
    // static face route. Both locations describe the same loader match.
    loaderDeps: (context: ApplicationContext, location: RouteLocation) =>
      sessionLoaderDeps(face, context, location),
    loader: async (context: ApplicationContext, { location, signal }) => {
      const { loadChatRoute } = await import("./route-loader.ts");
      return await loadChatRoute(context, location, face, signal);
    },
    component: () =>
      import("./chat-page.ts").then(() => ({
        header: true,
        // ChatPage owns pane/session teardown. The route namespace only changes
        // presentation, so it must not preempt that owner during face switches.
        renderOwnerKey: (match: SessionOwnerMatch, settled?: SessionOwnerMatch) =>
          sessionRenderOwnerKey(face, match, settled),
        render: (data: unknown) => {
          const routeData = data as ChatRouteData | undefined;
          if (!routeData) {
            return nothing;
          }
          return routeData.kind === "ambiguous"
            ? renderAmbiguous(routeData)
            : html`<openclaw-chat-page .data=${routeData}></openclaw-chat-page>`;
        },
      })),
  });
}

export const pages = [sessionPage("chat"), sessionPage("dashboard")] as const;
