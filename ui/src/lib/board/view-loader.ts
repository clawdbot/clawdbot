import { isMockBoardEnabled } from "./provider.ts";

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
