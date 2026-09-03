import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { isMockBoardEnabled, type BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";

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

export function renderBoardSessionSurface(props: BoardSessionSurfaceProps) {
  return html`
    <div class="board-session-surface" ?hidden=${!props.active} ?inert=${!props.active}>
      ${renderBoardView(props)}
    </div>
  `;
}
