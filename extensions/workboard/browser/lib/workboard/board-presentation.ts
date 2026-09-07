import { t } from "../../i18n/index.ts";
import type { WorkboardBoardSummary } from "./types.ts";

export function workboardBoardName(board: Pick<WorkboardBoardSummary, "id" | "name">): string {
  const name = board.name?.trim();
  return name || (board.id === "default" ? t("workboard.defaultBoard") : board.id);
}

export function workboardBoardLabel(board: Pick<WorkboardBoardSummary, "id" | "name">): string {
  const explicitName = board.name?.trim();
  return explicitName && explicitName !== board.id
    ? `${explicitName} (${board.id})`
    : workboardBoardName(board);
}

export function workboardBoardGlyph(
  board: Pick<WorkboardBoardSummary, "id" | "name" | "icon">,
): string {
  const icon = board.icon?.trim();
  if (icon) {
    return icon;
  }
  return Array.from(workboardBoardName(board))[0]?.toLocaleUpperCase() ?? "#";
}

export function workboardBoardColor(
  board: Pick<WorkboardBoardSummary, "color">,
): string | undefined {
  return board.color?.trim() || undefined;
}
