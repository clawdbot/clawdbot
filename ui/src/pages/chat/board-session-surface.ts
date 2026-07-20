import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { isMockBoardEnabled, type BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardFace, BoardVisibleChatDock } from "../../lib/board/settings.ts";
import type { BoardTab } from "../../lib/board/types.ts";
import type { BoardViewSnapshot, BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";

export type BoardChatDockSize = {
  height: number;
  width: number;
};

type BoardSessionSurfaceProps = {
  snapshot: BoardViewSnapshot;
  sessions: readonly GatewaySessionRow[];
  activeTabId: string;
  dock: BoardTab["chatDock"];
  reopenDock: BoardVisibleChatDock;
  dockSize: BoardChatDockSize;
  chat: TemplateResult;
  divider: TemplateResult;
  callbacks: BoardViewCallbacks;
  widgetFrameUrl: BoardWidgetFrameUrl;
  onDockChange: (dock: BoardTab["chatDock"]) => void;
};

let boardViewLoad: Promise<unknown> | null = null;

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

export function renderBoardFaceToggle(
  hasBoard: boolean,
  face: BoardFace,
  onChange: (face: BoardFace) => void,
) {
  if (!hasBoard) {
    return nothing;
  }
  return html`
    <div class="chat-pane__face-switch">
      ${renderSettingsSegmented<BoardFace>({
        value: face,
        ariaLabel: t("chat.board.faceLabel"),
        options: [
          { value: "chat", label: t("chat.board.chatFace") },
          { value: "dashboard", label: t("chat.board.dashboardFace") },
        ],
        onChange: (value) => onChange(value),
      })}
    </div>
  `;
}

function dockIcon(dock: BoardTab["chatDock"]) {
  if (dock === "left") {
    return icons.panelLeftOpen;
  }
  if (dock === "bottom") {
    return icons.panelBottomOpen;
  }
  if (dock === "hidden") {
    return icons.eyeOff;
  }
  return icons.panelRightOpen;
}

function dockLabel(dock: BoardTab["chatDock"]): string {
  if (dock === "left") {
    return t("chat.board.dockLeft");
  }
  if (dock === "bottom") {
    return t("chat.board.dockBottom");
  }
  if (dock === "hidden") {
    return t("chat.board.dockHidden");
  }
  return t("chat.board.dockRight");
}

export function renderBoardDockMenu(
  hasBoard: boolean,
  face: BoardFace,
  dock: BoardTab["chatDock"],
  onChange: (dock: BoardTab["chatDock"]) => void,
) {
  if (!hasBoard || face !== "dashboard") {
    return nothing;
  }
  return html`
    <wa-dropdown
      class="chat-pane__board-dock-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const value = event.detail.item.value;
        if (value === "left" || value === "right" || value === "bottom" || value === "hidden") {
          onChange(value);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--ghost btn--icon chat-icon-btn"
        data-board-dock-menu
        title=${dockLabel(dock)}
        aria-label=${t("chat.board.dockMenu", { dock: dockLabel(dock) })}
      >
        ${dockIcon(dock)}
      </button>
      ${(["left", "right", "bottom", "hidden"] as const).map(
        (candidate) => html`
          <wa-dropdown-item value=${candidate} type="checkbox" ?checked=${candidate === dock}>
            ${dockLabel(candidate)}
          </wa-dropdown-item>
        `,
      )}
    </wa-dropdown>
  `;
}

function renderBoardView(props: BoardSessionSurfaceProps) {
  return html`
    <div class="board-session-surface__board">
      <openclaw-board-view
        .snapshot=${props.snapshot}
        .activeTabId=${props.activeTabId}
        .widgetFrameUrl=${props.widgetFrameUrl}
        .callbacks=${props.callbacks}
        .sessions=${props.sessions}
      ></openclaw-board-view>
    </div>
  `;
}

function renderChatDock(props: BoardSessionSurfaceProps, dock: BoardVisibleChatDock) {
  const style =
    dock === "bottom" ? `height: ${props.dockSize.height}px` : `width: ${props.dockSize.width}px`;
  return html`<div class="board-session-surface__chat" style=${style}>${props.chat}</div>`;
}

export function renderBoardSessionSurface(props: BoardSessionSurfaceProps) {
  const layoutDock = props.dock === "hidden" ? props.reopenDock : props.dock;
  return html`
    <div class="board-session-surface board-session-surface--dock-${props.dock}">
      ${renderBoardView(props)} ${props.divider} ${renderChatDock(props, layoutDock)}
      <button
        type="button"
        class="board-session-surface__reopen board-session-surface__reopen--${props.reopenDock}"
        aria-label=${t("chat.board.reopenChat")}
        title=${t("chat.board.reopenChat")}
        ?hidden=${props.dock !== "hidden"}
        @click=${() => props.onDockChange(props.reopenDock)}
      >
        ${icons.messageSquare}<span>${t("chat.board.chatFace")}</span>
      </button>
    </div>
  `;
}
