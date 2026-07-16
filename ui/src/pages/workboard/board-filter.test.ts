import { describe, expect, it } from "vitest";
import type { WorkboardBoardSummary, WorkboardCard } from "../../lib/workboard/index.ts";
import {
  boardFilterFromSearch,
  buildBoardFilterOptions,
  matchesBoardFilter,
  normalizeActiveBoardFilter,
  searchForBoardFilter,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "./board-filter.ts";

function card(boardId?: string): WorkboardCard {
  return {
    id: boardId ?? "default-card",
    title: boardId ?? "Default card",
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(boardId ? { metadata: { automation: { boardId } } } : {}),
  };
}

function board(overrides: Partial<WorkboardBoardSummary> & Pick<WorkboardBoardSummary, "id">) {
  return {
    total: 0,
    active: 0,
    archived: 0,
    byStatus: {},
    ...overrides,
  } satisfies WorkboardBoardSummary;
}

describe("Workboard board filter", () => {
  it("uses one canonical default identity and includes empty archived boards", () => {
    const options = buildBoardFilterOptions(
      [
        board({ id: "archive", name: "Old work", archivedAt: 9 }),
        board({ id: "ops", name: "Operations", total: 99, active: 99 }),
        board({ id: "default", total: 99, active: 99 }),
        board({ id: "ops", name: "Duplicate" }),
      ],
      [
        card(),
        card("ops"),
        { ...card("ops"), id: "ops-2" },
        {
          ...card("ops"),
          id: "ops-archived",
          metadata: { automation: { boardId: "ops" }, archivedAt: 9 },
        },
      ],
    );

    expect(options.map((option) => option.value)).toEqual([
      WORKBOARD_ALL_BOARDS_FILTER,
      "default",
      "archive",
      "ops",
    ]);
    expect(options[1]?.label).toBe("Default board");
    expect(options[2]).toMatchObject({
      label: "Old work (archive)",
      description: "Archived · 0 active · 0 total",
    });
    expect(options[3]).toMatchObject({
      label: "Operations (ops)",
      description: "2 active · 3 total",
    });
    expect(normalizeActiveBoardFilter(options, "missing")).toBe(WORKBOARD_ALL_BOARDS_FILTER);
  });

  it("maps cards without an explicit board to default", () => {
    expect(matchesBoardFilter(card(), "default")).toBe(true);
    expect(matchesBoardFilter(card("ops"), "default")).toBe(false);
    expect(matchesBoardFilter(card("ops"), "ops")).toBe(true);
    expect(matchesBoardFilter(card("ops"), WORKBOARD_ALL_BOARDS_FILTER)).toBe(true);
  });

  it("round-trips the shareable board query without dropping other parameters", () => {
    expect(boardFilterFromSearch("?agent=main&board=ops")).toBe("ops");
    expect(searchForBoardFilter("?agent=main", "ops")).toBe("?agent=main&board=ops");
    expect(searchForBoardFilter("?agent=main&board=ops", WORKBOARD_ALL_BOARDS_FILTER)).toBe(
      "?agent=main",
    );
  });
});
