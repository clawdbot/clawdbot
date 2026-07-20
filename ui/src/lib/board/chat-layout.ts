import type { BoardFace } from "./settings.ts";
import type { BoardTab } from "./types.ts";

export function resolveBoardChatLayoutWidth(params: {
  paneWidth: number;
  hasBoard: boolean;
  face: BoardFace;
  dock: BoardTab["chatDock"];
  dockWidth: number;
}): number {
  return params.hasBoard &&
    params.face === "dashboard" &&
    (params.dock === "left" || params.dock === "right")
    ? Math.min(params.paneWidth, params.dockWidth)
    : params.paneWidth;
}
