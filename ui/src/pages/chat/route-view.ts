import type { RouteMatch } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { renderPanelErrorState } from "../../components/lazy-view-error.ts";
import { t } from "../../i18n/index.ts";
import type { ChatRouteData } from "./route-loader.ts";

const CHAT_PAGE_OWNER_KEY = "chat-page";

function navigateTo(href: string) {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

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

function renderMissingSession(data: Extract<ChatRouteData, { kind: "missing-session" }>) {
  return renderPanelErrorState({
    className: "session-route-not-found",
    role: "status",
    title: t("chat.sessionRoute.notFoundTitle"),
    subtitle: t("chat.sessionRoute.notFoundExplanation"),
    actions: html`
      <button class="btn primary" type="button" @click=${() => navigateTo(data.currentSessionHref)}>
        ${t("chat.sessionRoute.goToMain")}
      </button>
      <button class="btn" type="button" @click=${() => navigateTo(data.sessionsHref)}>
        ${t("chat.sessionRoute.viewSessions")}
      </button>
    `,
  });
}

export function renderChatRoute(data: unknown) {
  // SAFETY: This renderer receives only this route's colocated ChatRouteData loader result.
  const routeData = data as ChatRouteData | undefined;
  if (!routeData) {
    return nothing;
  }
  if (routeData.kind === "ambiguous") {
    return renderAmbiguous(routeData);
  }
  if (routeData.kind === "route-error") {
    return html`<section class="card"><p role="alert">${routeData.message}</p></section>`;
  }
  if (routeData.kind === "missing-session") {
    return renderMissingSession(routeData);
  }
  return html`<openclaw-chat-page .data=${routeData}></openclaw-chat-page>`;
}

export function sessionRenderOwnerKey(
  match: Pick<RouteMatch, "data">,
  settled: Pick<RouteMatch, "data"> | undefined,
): string | undefined {
  // SAFETY: Both matches carry only this route's colocated ChatRouteData loader result.
  const data = (match.data ?? settled?.data) as ChatRouteData | undefined;
  return data?.kind === "session" ? CHAT_PAGE_OWNER_KEY : undefined;
}
