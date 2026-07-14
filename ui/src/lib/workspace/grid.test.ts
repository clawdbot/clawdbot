import { describe, expect, it } from "vitest";
import {
  beginDrag,
  collides,
  gridPlacementStyle,
  gridRowCount,
  nudgeRect,
  resolveDrop,
  updateDrag,
  WORKSPACE_GRID_GAP,
} from "./grid.ts";
import type { WorkspaceWidget } from "./types.ts";

function widget(id: string, x: number, y: number, w: number, h: number): WorkspaceWidget {
  return { id, kind: "builtin:stat-card", title: id, grid: { x, y, w, h }, collapsed: false };
}

describe("workspace grid public operations", () => {
  it("snaps pointer movement using computed column width and gaps", () => {
    const drag = beginDrag({
      widget: widget("a", 0, 0, 4, 2),
      mode: "move",
      clientX: 0,
      clientY: 0,
      metrics: { width: 720 },
    });
    expect(drag.columnWidth).toBe(49);
    expect(updateDrag(drag, 122, 68)).toEqual({ x: 2, y: 1, w: 4, h: 2 });
  });

  it("clamps drag and keyboard operations to server grid bounds", () => {
    const drag = beginDrag({
      widget: widget("a", 10, 498, 4, 20),
      mode: "resize",
      clientX: 0,
      clientY: 0,
      metrics: { width: 720 },
    });
    expect(updateDrag(drag, 1_000, 1_000)).toEqual({ x: 0, y: 498, w: 12, h: 20 });
    expect(nudgeRect({ x: 0, y: 499, w: 2, h: 1 }, "move", "down")).toEqual({
      x: 0,
      y: 499,
      w: 2,
      h: 1,
    });
    expect(nudgeRect({ x: 0, y: 0, w: 1, h: 1 }, "resize", "left")).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it("treats touching edges as free and overlapping cells as collisions", () => {
    const widgets = [widget("a", 0, 0, 4, 2), widget("b", 4, 0, 4, 2)];
    expect(collides({ x: 8, y: 0, w: 4, h: 2 }, widgets, "c")).toBe(false);
    expect(collides({ x: 3, y: 1, w: 4, h: 2 }, widgets, "c")).toBe(true);
    expect(collides({ x: 0, y: 0, w: 4, h: 2 }, widgets, "a")).toBe(false);
  });

  it("offers the nearest expected free slot for an overlapping drop", () => {
    const widgets = [widget("a", 0, 0, 10, 1)];
    expect(resolveDrop({ requested: { x: 0, y: 0, w: 2, h: 1 }, widgets, widgetId: "b" })).toEqual({
      x: 0,
      y: 1,
      w: 2,
      h: 1,
    });
  });

  it("never proposes a slot beyond the store's last row", () => {
    const widgets = [widget("a", 0, 495, 12, 5)];
    const slot = resolveDrop({
      requested: { x: 0, y: 498, w: 4, h: 2 },
      widgets,
      widgetId: "b",
    });
    expect(slot === null || slot.y + slot.h - 1 <= 499).toBe(true);
    if (slot) {
      expect(collides(slot, widgets, "b")).toBe(false);
    }
  });

  it("renders placement, row count, and the shared gap contract", () => {
    expect(gridPlacementStyle({ x: 8, y: 3, w: 4, h: 1 })).toBe(
      "grid-column: 9 / span 4; grid-row: 4 / span 1",
    );
    expect(gridRowCount([widget("a", 0, 0, 4, 2), widget("b", 4, 1, 4, 3)])).toBe(4);
    expect(WORKSPACE_GRID_GAP).toBe(12);
  });
});
