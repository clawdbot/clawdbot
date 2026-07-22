import { html, type TemplateResult } from "lit";
import { pathForRoute } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import { WORKBOARD_STATUSES, type WorkboardCard } from "../../workboard/types.ts";
import type { BoardViewWidget } from "../view-types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";
import { WorkboardWidgetElement } from "./workboard-widget.ts";

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

class OpenClawWorkboardMiniWidget extends WorkboardWidgetElement {
  override render(): TemplateResult {
    if (this.loading && !this.loaded) {
      return html`<p class="workboard-widget__state">${t("workboard.widget.loading")}</p>`;
    }
    if (this.error) {
      return html`<div class="workboard-widget__state" role="alert">
        <span>${this.error}</span>
        <button class="btn btn--sm" type="button" @click=${() => this.retryLoad()}>
          ${t("common.retry")}
        </button>
      </div>`;
    }
    const boardId = this.readStringProp("boardId") ?? "default";
    const limit = Math.min(10, this.readPositiveIntegerProp("limit", 5));
    const cards = this.cards.filter((card) => cardBoardId(card) === boardId);
    const topCards = cards
      .filter((card) => card.status === "ready" || card.status === "running")
      .toSorted(
        (left, right) =>
          Number(right.status === "running") - Number(left.status === "running") ||
          left.position - right.position ||
          left.title.localeCompare(right.title),
      )
      .slice(0, limit);
    const workboardPath = `${pathForRoute("workboard", this.context?.basePath ?? "")}?board=${encodeURIComponent(boardId)}`;
    return html`
      <section class="workboard-widget-mini" data-test-id="workboard-mini-widget">
        <header>
          <strong>${boardId}</strong>
          <a href=${workboardPath}>${t("workboard.widget.openBoard")}</a>
        </header>
        <div class="workboard-widget-mini__counts" aria-label=${t("workboard.widget.statusCounts")}>
          ${WORKBOARD_STATUSES.map(
            (status) => html`
              <span title=${t(`workboard.status.${status}`)}>
                <b>${cards.filter((card) => card.status === status).length}</b>
                ${t(`workboard.status.${status}`)}
              </span>
            `,
          )}
        </div>
        <div class="workboard-widget-mini__cards">
          ${topCards.length > 0
            ? topCards.map(
                (card) => html`
                  <div class="workboard-widget-mini__card">
                    <span
                      class=${`workboard-widget__status workboard-widget__status--${card.status}`}
                    >
                      ${t(`workboard.status.${card.status}`)}
                    </span>
                    <strong>${card.title}</strong>
                  </div>
                `,
              )
            : html`<p class="workboard-widget__state">${t("workboard.widget.noActiveCards")}</p>`}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-workboard-mini-widget")) {
  customElements.define("openclaw-workboard-mini-widget", OpenClawWorkboardMiniWidget);
}

export const renderWorkboardMiniWidget: PluginBoardWidgetRenderer = ({
  widget,
  sessionKey,
  requestUpdate,
}: {
  widget: BoardViewWidget;
  sessionKey: string;
  requestUpdate: () => void;
}) => html`
  <openclaw-workboard-mini-widget
    .widget=${widget}
    .sessionKey=${sessionKey}
    .hostRequestUpdate=${requestUpdate}
  ></openclaw-workboard-mini-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workboard-mini-widget": OpenClawWorkboardMiniWidget;
  }
}
