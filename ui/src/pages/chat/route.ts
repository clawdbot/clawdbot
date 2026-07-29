import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { ChatRouteData } from "./route-loader.ts";

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

function sessionPage(face: BoardFace) {
  return definePage({
    ...routePageSpec(face),
    loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
      `${location.pathname}\u0000${location.search}`,
    loader: async (context: ApplicationContext, { location, signal }) => {
      const { loadChatRoute } = await import("./route-loader.ts");
      return await loadChatRoute(context, location, face, signal);
    },
    component: () =>
      import("./chat-page.ts").then(() => ({
        header: true,
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
