import { describe, expect, it } from "vitest";
import {
  SIDEBAR_MIN_WIDTH_PX,
  activatePanel,
  closeSlot,
  detachPanelToColumn,
  fitSidebarLayout,
  mergePanelIntoColumn,
  normalizeSidebarLayout,
  openSlot,
  resizeColumn,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function openAll(): SidebarLayout {
  return openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "chat"), "detail");
}

describe("sidebar layout", () => {
  it("opens each slot in its own ranked column", () => {
    const layout = openAll();
    expect(layout.columns.map((column) => column.panels[0]?.slot)).toEqual([
      "chat",
      "detail",
      "discussion",
    ]);
    expect(layout.columns.every((column) => column.panels.length === 1)).toBe(true);
    expect(layout.columns[2]?.panels[0]?.slot).toBe("discussion");
    expect(layout.columns[0]?.width).toBe(480);
    expect(layout.columns[1]?.width).toBe(360);
  });

  it("merges panels into a tabbed column and activates the moved panel", () => {
    const layout = openAll();
    const detail = layout.columns[1]?.panels[0];
    const discussionColumn = layout.columns[2];
    expect(detail).toBeDefined();
    expect(discussionColumn).toBeDefined();
    const merged = mergePanelIntoColumn(layout, detail!.id, discussionColumn!.id, 0);
    expect(merged.columns).toHaveLength(2);
    expect(merged.columns[1]?.panels.map((panel) => panel.slot)).toEqual(["detail", "discussion"]);
    expect(merged.columns[1]?.activePanelId).toBe(detail!.id);
    expect(activatePanel(merged, discussionColumn!.activePanelId).columns[1]?.activePanelId).toBe(
      discussionColumn!.activePanelId,
    );
  });

  it("detaches a tab back into its own column", () => {
    const layout = openAll();
    const detail = layout.columns[1]?.panels[0];
    const target = layout.columns[2];
    const merged = mergePanelIntoColumn(layout, detail!.id, target!.id, 0);
    const detached = detachPanelToColumn(merged, detail!.id, "right", 1);
    expect(detached.columns.map((column) => column.panels.map((panel) => panel.slot))).toEqual([
      ["chat"],
      ["detail"],
      ["discussion"],
    ]);
  });

  it("adjusts a later same-side boundary after removing the source column", () => {
    const layout = openAll();
    const chat = layout.columns[0]!.panels[0]!;
    const moved = detachPanelToColumn(layout, chat.id, "right", 2);
    expect(moved.columns.map((column) => column.panels[0]?.slot)).toEqual([
      "detail",
      "chat",
      "discussion",
    ]);
  });

  it("adjusts insertion indexes when reordering tabs within one column", () => {
    const layout = openAll();
    const detail = layout.columns[1]!.panels[0]!;
    const discussionColumn = layout.columns[2]!;
    const merged = mergePanelIntoColumn(layout, detail.id, discussionColumn.id, 0);
    const movedAfter = mergePanelIntoColumn(merged, detail.id, discussionColumn.id, 2);
    expect(movedAfter.columns[1]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "detail",
    ]);
    const movedBefore = mergePanelIntoColumn(movedAfter, detail.id, discussionColumn.id, 0);
    expect(movedBefore.columns[1]?.panels.map((panel) => panel.slot)).toEqual([
      "detail",
      "discussion",
    ]);
  });

  it("clamps resized widths at both ends", () => {
    const layout = openSlot({ columns: [] }, "detail");
    const columnId = layout.columns[0]!.id;
    expect(resizeColumn(layout, columnId, 1).columns[0]?.width).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(resizeColumn(layout, columnId, Number.MAX_VALUE).columns[0]?.width).toBe(1_200);
  });

  it("shrinks the widest columns before refusing a region that cannot fit minimums", () => {
    const fitted = fitSidebarLayout(openAll(), 1_200);
    expect(fitted).not.toBeNull();
    expect(fitted!.columns.reduce((sum, column) => sum + column.width, 0)).toBe(876);
    expect(fitSidebarLayout(openAll(), 1_000)).toBeNull();
  });

  it("removes a column when its last panel closes", () => {
    expect(closeSlot(openSlot({ columns: [] }, "detail"), "detail")).toEqual({ columns: [] });
  });

  it("allocates a unique panel id when persisted ids collide with a slot", () => {
    const layout = normalizeSidebarLayout({
      columns: [
        {
          id: "detail-column",
          side: "right",
          panels: [{ id: "chat", slot: "detail" }],
          activePanelId: "chat",
          width: 360,
        },
      ],
    });
    expect(openSlot(layout, "chat").columns[0]?.panels[0]?.id).toBe("chat-2");
  });

  it("preserves the active tab when a missing panel id uses its slot fallback", () => {
    const layout = normalizeSidebarLayout({
      columns: [
        {
          id: "tabs",
          side: "right",
          panels: [{ id: "detail", slot: "detail" }, { slot: "discussion" }],
          activePanelId: "discussion",
          width: 360,
        },
      ],
    });
    expect(layout.columns[0]?.activePanelId).toBe("discussion");
  });

  it("round-trips valid layouts and rejects or repairs untrusted values", () => {
    const valid = openAll();
    expect(normalizeSidebarLayout(valid)).toEqual(valid);
    expect(normalizeSidebarLayout(null)).toEqual({ columns: [] });
    expect(normalizeSidebarLayout({ columns: "nope" })).toEqual({ columns: [] });
    expect(
      normalizeSidebarLayout({
        columns: [
          {
            id: "same",
            side: "right",
            panels: [
              { id: "same-panel", slot: "detail" },
              { id: "unknown", slot: "unknown" },
            ],
            activePanelId: "missing",
            width: 20,
          },
          {
            id: "same",
            side: "right",
            panels: [
              { id: "same-panel", slot: "discussion" },
              { id: "duplicate-slot", slot: "detail" },
            ],
            activePanelId: "same-panel",
            width: 50_000,
          },
        ],
      }),
    ).toEqual({
      columns: [
        {
          id: "same",
          side: "right",
          panels: [{ id: "same-panel", slot: "detail" }],
          activePanelId: "same-panel",
          width: SIDEBAR_MIN_WIDTH_PX,
        },
        {
          id: "same-2",
          side: "right",
          panels: [{ id: "same-panel-2", slot: "discussion" }],
          activePanelId: "same-panel-2",
          width: 1_200,
        },
      ],
    });
  });
});
