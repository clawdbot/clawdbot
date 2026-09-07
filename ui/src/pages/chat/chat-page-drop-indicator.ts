import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import {
  resolveSplitDropZone,
  splitDropIndicatorRect,
  type SplitDropRect,
  type SplitDropZone,
} from "./split-drop-zone.ts";

export type DropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };

export function resolveDropIndicator(
  host: ParentNode,
  pane: ChatPaneElement,
  x: number,
  y: number,
): DropIndicator | null {
  const paneId = pane.paneId;
  const container = host.querySelector<HTMLElement>(".chat-split-view__drop-container");
  if (!paneId || !container) {
    return null;
  }
  const paneRect = pane.getBoundingClientRect();
  const zone = resolveSplitDropZone(paneRect, x, y);
  const indicatorRect = splitDropIndicatorRect(paneRect, zone);
  const containerRect = container.getBoundingClientRect();
  return {
    paneId,
    zone,
    rect: {
      left: indicatorRect.left - containerRect.left,
      top: indicatorRect.top - containerRect.top,
      width: indicatorRect.width,
      height: indicatorRect.height,
    },
  };
}
