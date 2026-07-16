import { t } from "../../i18n/index.ts";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardUiState,
} from "../../lib/workboard/index.ts";
import type { WorkboardSelectOption } from "./workboard-select.ts";

export const WORKBOARD_ALL_BOARDS_FILTER = "__all__";

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId?.trim() || "default";
}

export function matchesBoardFilter(
  card: WorkboardCard,
  filter: WorkboardUiState["boardFilter"],
): boolean {
  return filter === WORKBOARD_ALL_BOARDS_FILTER || cardBoardId(card) === filter;
}

function boardLabel(board: WorkboardBoardSummary): string {
  const name = board.name?.trim();
  if (name && name !== board.id) {
    return `${name} (${board.id})`;
  }
  return name || (board.id === "default" ? t("workboard.defaultBoard") : board.id);
}

function boardDescription(board: WorkboardBoardSummary): string {
  const params = { active: String(board.active), total: String(board.total) };
  return board.archivedAt
    ? t("workboard.boardFilterArchivedSummary", params)
    : t("workboard.boardFilterSummary", params);
}

export function buildBoardFilterOptions(
  boards: readonly WorkboardBoardSummary[],
  cards: readonly WorkboardCard[],
): WorkboardSelectOption[] {
  const uniqueBoards = new Map<string, WorkboardBoardSummary>();
  for (const board of boards) {
    const id = board.id.trim();
    if (id && !uniqueBoards.has(id)) {
      uniqueBoards.set(id, {
        ...board,
        id,
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      });
    }
  }
  for (const card of cards) {
    const id = cardBoardId(card);
    const board: WorkboardBoardSummary = uniqueBoards.get(id) ?? {
      id,
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
    };
    board.total += 1;
    if (card.metadata?.archivedAt) {
      board.archived += 1;
    } else {
      board.active += 1;
    }
    board.byStatus[card.status] = (board.byStatus[card.status] ?? 0) + 1;
    uniqueBoards.set(id, board);
  }
  const sortedBoards = [...uniqueBoards.values()].toSorted((left, right) => {
    if (left.id === "default") {
      return -1;
    }
    if (right.id === "default") {
      return 1;
    }
    return boardLabel(left).localeCompare(boardLabel(right));
  });
  return [
    { value: WORKBOARD_ALL_BOARDS_FILTER, label: t("workboard.allBoards") },
    ...sortedBoards.map((board) => ({
      value: board.id,
      label: boardLabel(board),
      description: boardDescription(board),
    })),
  ];
}

export function normalizeActiveBoardFilter(
  options: readonly WorkboardSelectOption[],
  filter: WorkboardUiState["boardFilter"],
): WorkboardUiState["boardFilter"] {
  return options.some((option) => option.value === filter) ? filter : WORKBOARD_ALL_BOARDS_FILTER;
}

export function boardFilterFromSearch(search: string): string {
  const board = new URLSearchParams(search).get("board")?.trim();
  return board && board !== WORKBOARD_ALL_BOARDS_FILTER ? board : WORKBOARD_ALL_BOARDS_FILTER;
}

export function searchForBoardFilter(search: string, filter: string): string {
  const params = new URLSearchParams(search);
  if (filter === WORKBOARD_ALL_BOARDS_FILTER) {
    params.delete("board");
  } else {
    params.set("board", filter);
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}
