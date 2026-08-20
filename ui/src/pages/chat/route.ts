import type { RouteLocation, RouteMatch } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { INTERNAL_SESSION_PATH_PARAM, pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { ChatRouteData } from "./route-loader.ts";

type SessionOwnerMatch = Pick<RouteMatch, "data">;
const CHAT_PAGE_OWNER_KEY = "chat-page";

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

function sessionRenderOwnerKey(match: SessionOwnerMatch): string | undefined {
  const data = match.data as ChatRouteData | undefined;
  return data?.kind === "ambiguous" ? undefined : CHAT_PAGE_OWNER_KEY;
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
        // ChatPage's bounded inner cache owns per-session teardown, so session
        // routes share the outer owner while their data and URL keep changing.
        renderOwnerKey: sessionRenderOwnerKey,
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
