import { describe, expect, it } from "vitest";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { resolveSidebarLayoutForBoard } from "./chat-pane-sidebar-layout.ts";
import { openSlot } from "./sidebar-layout.ts";

function board(dock: ResolvedBoardView["dock"], face: ResolvedBoardView["face"] = "dashboard") {
  return {
    hasBoard: true,
    face,
    dock,
  } as ResolvedBoardView;
}

describe("chat pane sidebar layout", () => {
  it("promotes side-docked dashboard chat into the requested side", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("left"),
      hasDetail: false,
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    expect(layout.columns[0]?.side).toBe("left");
    expect(layout.columns[0]?.panels[0]?.slot).toBe("chat");
  });

  it("keeps bottom chat outside the sidebar model", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("bottom"),
      hasDetail: true,
      layout: openSlot(openSlot({ columns: [] }, "chat"), "detail"),
      paneWidth: 1_400,
    });
    expect(layout.columns.flatMap((column) => column.panels.map((panel) => panel.slot))).toEqual([
      "detail",
    ]);
  });

  it("drops stale detail placement when no transient detail is available", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("hidden", "chat"),
      hasDetail: false,
      layout: openSlot({ columns: [] }, "detail"),
      paneWidth: 1_400,
    });
    expect(layout).toEqual({ columns: [] });
  });

  it("refits ordinary chat columns to preserve the primary minimum", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("hidden", "chat"),
      hasDetail: true,
      layout: openSlot(openSlot({ columns: [] }, "detail"), "discussion"),
      paneWidth: 1_000,
    });
    expect(layout.columns.reduce((sum, column) => sum + column.width, 0)).toBe(680);
  });
});
