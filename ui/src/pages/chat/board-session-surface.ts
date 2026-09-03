import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { isMockBoardEnabled, type BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardFace, BoardVisibleChatDock } from "../../lib/board/settings.ts";
import type { BoardSnapshot, BoardTab } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";

export type BoardChatDockSize = {
  height: number;
};

export type WorkboardCardChipProps = {
  active: boolean;
  basePath: string;
  client: GatewayBrowserClient;
  sessionKey: string;
};

type BoardSessionSurfaceProps = {
  active: boolean;
  snapshot: BoardSnapshot;
  activeTabId: string;
  dock: BoardTab["chatDock"];
  dockSize: BoardChatDockSize;
  chat: TemplateResult;
  divider: TemplateResult;
  canMutate: boolean;
  canGrant: boolean;
  callbacks: BoardViewCallbacks;
  widgetFrameUrl: BoardWidgetFrameUrl;
  workboardCardChip?: WorkboardCardChipProps | null;
};

let boardViewLoad: Promise<unknown> | null = null;

export function ensureWorkboardCardChipElement(): Promise<void> {
  return ensureCustomElementDefined(
    "openclaw-workboard-card-chip",
    () => import("./workboard-card-chip.runtime.ts"),
  );
}

export async function ensureBoardViewElement(): Promise<boolean> {
  if (customElements.get("openclaw-board-view")) {
    return false;
  }
  boardViewLoad ??= isMockBoardEnabled()
    ? import("../../components/board-view-placeholder.ts")
    : import("../../components/board/board-view.ts");
  await boardViewLoad;
  return true;
}

type BoardViewMode = "chat" | "split" | "dashboard";

function dockLabel(dock: BoardVisibleChatDock): string {
  if (dock === "left") {
    return t("chat.board.dockLeft");
  }
  if (dock === "bottom") {
    return t("chat.board.dockBottom");
  }
  return t("chat.board.dockRight");
}

function modeLabel(icon: TemplateResult, label: string) {
  return html`<span class="chat-pane__face-option">
    ${icon}<span class="chat-pane__face-label">${label}</span>
  </span>`;
}

export function renderBoardViewSwitch(props: {
  hasBoard: boolean;
  face: BoardFace;
  dock: BoardTab["chatDock"];
  canChangeDock: boolean;
  fullscreenControl?: TemplateResult;
  onSelectMode: (mode: BoardViewMode) => void;
  onDockSideChange: (dock: BoardVisibleChatDock) => void;
}) {
  if (!props.hasBoard) {
    return nothing;
  }

  const mode: BoardViewMode =
    props.face === "chat" ? "chat" : props.dock === "hidden" ? "dashboard" : "split";
  const segmented = props.canChangeDock
    ? renderSettingsSegmented<BoardViewMode>({
        value: mode,
        ariaLabel: t("chat.board.faceLabel"),
        options: [
          {
            value: "chat",
            label: modeLabel(icons.messageSquare, t("chat.board.chatFace")),
            title: t("chat.board.chatFace"),
          },
          {
            value: "split",
            label: modeLabel(icons.columns2, t("chat.board.splitFace")),
            title: t("chat.board.splitFace"),
          },
          {
            value: "dashboard",
            label: modeLabel(icons.layoutDashboard, t("chat.board.dashboardFace")),
            title: t("chat.board.dashboardFace"),
          },
        ],
        onChange: (value) => props.onSelectMode(value),
      })
    : renderSettingsSegmented<BoardFace>({
        value: props.face,
        ariaLabel: t("chat.board.faceLabel"),
        options: [
          {
            value: "chat",
            label: modeLabel(icons.messageSquare, t("chat.board.chatFace")),
            title: t("chat.board.chatFace"),
          },
          {
            value: "dashboard",
            label: modeLabel(icons.layoutDashboard, t("chat.board.dashboardFace")),
            title: t("chat.board.dashboardFace"),
          },
        ],
        onChange: (value) => props.onSelectMode(value),
      });
  const visibleDock = props.dock === "hidden" ? null : props.dock;
  const showDockCaret = mode === "split" && props.canChangeDock && visibleDock !== null;

  return html`
    <div class="chat-pane__face-switch ${showDockCaret ? "chat-pane__face-switch--split" : ""}">
      ${segmented}
      ${showDockCaret && visibleDock
        ? html`
            <wa-dropdown
              class="chat-pane__dock-caret"
              placement="bottom-end"
              @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                const value = event.detail.item.value;
                if (value === "left" || value === "right" || value === "bottom") {
                  props.onDockSideChange(value);
                }
              }}
            >
              <button
                slot="trigger"
                type="button"
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__dock-caret-trigger"
                title=${dockLabel(visibleDock)}
                aria-label=${t("chat.board.dockMenu", { dock: dockLabel(visibleDock) })}
              >
                ${icons.chevronDown}
              </button>
              ${(["left", "right", "bottom"] as const).map(
                (candidate) => html`
                  <wa-dropdown-item
                    value=${candidate}
                    type="checkbox"
                    ?checked=${candidate === visibleDock}
                  >
                    ${dockLabel(candidate)}
                  </wa-dropdown-item>
                `,
              )}
            </wa-dropdown>
          `
        : nothing}
      ${mode === "chat" ? nothing : props.fullscreenControl}
    </div>
  `;
}

function renderBoardView(props: BoardSessionSurfaceProps) {
  return html`
    <div class="board-session-surface__board">
      ${props.workboardCardChip
        ? html`
            <openclaw-workboard-card-chip
              .active=${props.workboardCardChip.active}
              .basePath=${props.workboardCardChip.basePath}
              .client=${props.workboardCardChip.client}
              .sessionKey=${props.workboardCardChip.sessionKey}
            ></openclaw-workboard-card-chip>
          `
        : nothing}
      <openclaw-board-view
        .active=${props.active}
        .snapshot=${props.snapshot}
        .activeTabId=${props.activeTabId}
        .widgetFrameUrl=${props.widgetFrameUrl}
        .callbacks=${props.callbacks}
        .canMutate=${props.canMutate}
        .canGrant=${props.canGrant}
      ></openclaw-board-view>
    </div>
  `;
}

function renderChatDock(props: BoardSessionSurfaceProps) {
  return html`<div class="board-session-surface__chat" style="height: ${props.dockSize.height}px">
    ${props.chat}
  </div>`;
}

export function renderBoardSessionSurface(props: BoardSessionSurfaceProps) {
  return html`
    <div
      class="board-session-surface board-session-surface--dock-${props.dock}"
      ?hidden=${!props.active}
      ?inert=${!props.active}
    >
      ${renderBoardView(props)}
      ${props.active && props.dock === "bottom"
        ? html`${props.divider}${renderChatDock(props)}`
        : nothing}
    </div>
  `;
}
