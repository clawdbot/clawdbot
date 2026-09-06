import type { WorkboardCard, WorkboardUiState } from "./types.ts";

export const WORKBOARD_ALL_BOARDS_FILTER = "__all__";

export function workboardCardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId?.trim() || "default";
}

export function matchesBoardFilter(
  card: WorkboardCard,
  filter: WorkboardUiState["boardFilter"],
): boolean {
  return filter === WORKBOARD_ALL_BOARDS_FILTER || workboardCardBoardId(card) === filter;
}
