import { html, type TemplateResult } from "lit";
import { pathForRoute } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import "../../../styles/workboard.css";
import { renderColumn } from "../../../pages/workboard/view-card.ts";
import type { WorkboardProps } from "../../../pages/workboard/view-helpers.ts";
import { matchesBoardFilter, WORKBOARD_ALL_BOARDS_FILTER } from "../../workboard/board-filter.ts";
import type { WorkboardCard, WorkboardStatus } from "../../workboard/types.ts";
import type { BoardWidget } from "../types.ts";
import type { PluginBoardWidgetRenderer } from "./index.ts";
import { WorkboardWidgetElement } from "./workboard-widget.ts";

class OpenClawWorkboardBoardWidget extends WorkboardWidgetElement {
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

    // No boardId prop means every board, matching the summary widget. Defaulting
    // here would silently hide cards owned by explicitly named boards.
    const boardId = this.readStringProp("boardId");
    const filter = boardId ?? WORKBOARD_ALL_BOARDS_FILTER;
    const cards = this.cards.filter((card) => matchesBoardFilter(card, filter));
    const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
    for (const status of this.statuses) {
      byStatus.set(status, []);
    }
    for (const card of cards) {
      byStatus.get(card.status)?.push(card);
    }

    const client = this.workboardClient;
    const props: WorkboardProps = {
      host: this.workboardStateHost,
      client,
      connected: client !== null,
      canWrite: this.canMutate,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => this.syncFromHost(),
    };
    const workboardBase = pathForRoute("workboard", this.context?.basePath ?? "");
    const workboardPath = boardId
      ? `${workboardBase}?board=${encodeURIComponent(boardId)}`
      : workboardBase;

    return html`
      <section class="workboard-widget-board" data-test-id="workboard-board-widget">
        <header class="workboard-widget-board__header">
          <strong>${boardId ?? t("workboard.allBoards")}</strong>
          <span>${t("workboard.widget.cardCount", { count: String(cards.length) })}</span>
          <a href=${workboardPath}>${t("workboard.widget.openBoard")}</a>
        </header>
        <div class="workboard-board workboard-board--compact workboard-widget-board__columns">
          ${this.statuses.map((status) =>
            renderColumn(props, status, byStatus.get(status) ?? [], { surface: "widget" }),
          )}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-workboard-board-widget")) {
  customElements.define("openclaw-workboard-board-widget", OpenClawWorkboardBoardWidget);
}

export const renderWorkboardBoardWidget: PluginBoardWidgetRenderer = ({
  widget,
  sessionKey,
  active,
  canMutate,
  requestUpdate,
}: {
  widget: BoardWidget;
  sessionKey: string;
  active: boolean;
  canMutate: boolean;
  requestUpdate: () => void;
}) => html`
  <openclaw-workboard-board-widget
    .widget=${widget}
    .sessionKey=${sessionKey}
    .active=${active}
    .canMutate=${canMutate}
    .hostRequestUpdate=${requestUpdate}
  ></openclaw-workboard-board-widget>
`;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workboard-board-widget": OpenClawWorkboardBoardWidget;
  }
}
