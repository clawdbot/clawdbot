import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT } from "../../lib/board/grid.ts";
import type { BoardWidgetAppViewState, BoardViewWidget } from "../../lib/board/view-types.ts";

const GRANT_NOTICE_HEIGHT_PX = 112;

type BoardMcpAppContentOptions = {
  accessNotice: TemplateResult | typeof nothing;
  appView?: BoardWidgetAppViewState;
  busy: boolean;
  loading: boolean;
  nearVisible: boolean;
  rectHeight: number;
  sessionKey: string;
  widget: BoardViewWidget;
  expired: () => void;
  remove: () => void;
  retry: () => void;
};

export function renderBoardMcpAppContent(options: BoardMcpAppContentOptions): TemplateResult {
  const { appView, widget } = options;
  const noticeHeight =
    widget.grantState === "pending" || widget.grantState === "rejected"
      ? GRANT_NOTICE_HEIGHT_PX
      : 0;
  const height = Math.max(
    160,
    options.rectHeight * BOARD_GRID_ROW_HEIGHT +
      Math.max(0, options.rectHeight - 1) * BOARD_GRID_GAP -
      38 -
      noticeHeight,
  );
  const ready =
    appView?.status === "ready" && appView.expiresAtMs > Date.now() ? appView : undefined;
  const loading = html`<div class="board-widget__app-loading" data-test-id="board-mcp-app-loading">
    ${t("board.widget.appLoading")}
  </div>`;
  const view =
    !options.nearVisible || !appView
      ? loading
      : appView.status === "stale"
        ? html`<div class="board-widget__stale" data-test-id="board-mcp-app-stale">
            <strong>${t("board.widget.appStaleTitle")}</strong>
            <span>${t("board.widget.appStaleDetail")}</span>
            <div class="board-widget__grant-actions">
              <button
                class="btn btn--small btn--primary"
                type="button"
                ?disabled=${options.loading}
                @click=${options.retry}
              >
                ${t("board.widget.retry")}
              </button>
              <button
                class="btn btn--small"
                type="button"
                ?disabled=${options.busy}
                @click=${options.remove}
              >
                ${t("board.widget.remove")}
              </button>
            </div>
          </div>`
        : ready
          ? html`<mcp-app-view
              class="board-widget__mcp-app-view"
              .sessionKey=${options.sessionKey}
              .viewId=${ready.viewId}
              .height=${height}
              .fixedHeight=${true}
              .title=${widget.title || widget.name}
              @openclaw-mcp-app-view-expired=${options.expired}
            ></mcp-app-view>`
          : loading;
  return html`<div class="board-widget__mcp-app">${options.accessNotice}${view}</div>`;
}
