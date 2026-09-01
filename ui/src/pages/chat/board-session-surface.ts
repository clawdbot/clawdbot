import { html } from "lit";
import "../../plugins/control-ui-contributions.ts";
import { isMockBoardEnabled, type BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";

type BoardSessionSurfaceProps = {
  active: boolean;
  snapshot: BoardSnapshot;
  activeTabId: string;
  canMutate: boolean;
  canGrant: boolean;
  callbacks: BoardViewCallbacks;
  widgetFrameUrl: BoardWidgetFrameUrl;
  sessionKey: string;
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

function renderBoardView(props: BoardSessionSurfaceProps) {
  return html`
    <div class="board-session-surface__board">
      <openclaw-plugin-contributions
        .kind=${"session-header"}
        .sessionKey=${props.sessionKey}
        .presented=${props.active}
      ></openclaw-plugin-contributions>
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

export function renderBoardSessionSurface(props: BoardSessionSurfaceProps) {
  return html`
    <div class="board-session-surface" ?hidden=${!props.active} ?inert=${!props.active}>
      ${renderBoardView(props)}
    </div>
  `;
}
