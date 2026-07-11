import { describe, expect, it } from "vitest";
import {
  clampRect,
  collides,
  columnWidth,
  WORKSPACE_GRID_GAP,
  gridPlacementStyle,
  gridRowCount,
  nearestFreeSlot,
  nudgeRect,
  rectsOverlap,
  resolveDrop,
  snapCells,
} from "./grid.ts";
import type { WorkspaceWidget } from "./types.ts";

function widget(id: string, x: number, y: number, w: number, h: number): WorkspaceWidget {
  return { id, kind: "builtin:stat-card", title: id, grid: { x, y, w, h }, collapsed: false };
}

describe("workspace grid math", () => {
  it("computes column width accounting for inter-column gaps", () => {
    // width 720, 12 cols, 11 gaps of 12px = 132 → (720-132)/12 = 49
    expect(columnWidth({ width: 720 })).toBe(49);
  });

  it("snaps a pixel delta to whole grid units including the gap", () => {
    // unit 49 + gap 12 = 61 per cell
    expect(snapCells(0, 49)).toBe(0);
    expect(snapCells(61, 49)).toBe(1);
    expect(snapCells(90, 49)).toBe(1);
    expect(snapCells(122, 49)).toBe(2);
    expect(snapCells(-61, 49)).toBe(-1);
  });

  it("clamps rects inside the 12-column grid", () => {
    expect(clampRect({ x: -3, y: -2, w: 20, h: 0 })).toEqual({ x: 0, y: 0, w: 12, h: 1 });
    expect(clampRect({ x: 10, y: 1, w: 4, h: 2 })).toEqual({ x: 8, y: 1, w: 4, h: 2 });
  });

  it("treats touching edges as non-overlapping", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 4, y: 0, w: 4, h: 2 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 2, w: 4, h: 2 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 3, y: 1, w: 4, h: 2 })).toBe(true);
  });

  it("detects collisions against other widgets, ignoring self", () => {
    const widgets = [widget("a", 0, 0, 4, 2), widget("b", 4, 0, 4, 2)];
    expect(collides({ x: 2, y: 0, w: 4, h: 2 }, widgets, "b")).toBe(true);
    expect(collides({ x: 0, y: 0, w: 4, h: 2 }, widgets, "a")).toBe(false);
    expect(collides({ x: 8, y: 0, w: 4, h: 2 }, widgets, "c")).toBe(false);
  });

  it("accepts a non-overlapping drop as-is", () => {
    const widgets = [widget("a", 0, 0, 4, 2), widget("b", 4, 0, 4, 2)];
    expect(resolveDrop({ requested: { x: 8, y: 0, w: 4, h: 2 }, widgets, widgetId: "b" })).toEqual({
      x: 8,
      y: 0,
      w: 4,
      h: 2,
    });
  });

  it("rejects an overlapping drop and offers the nearest free slot", () => {
    const widgets = [widget("a", 0, 0, 4, 2), widget("b", 4, 0, 4, 2)];
    // Dropping b onto a's cells must not overlap; nearest free slot is offered.
    const resolved = resolveDrop({ requested: { x: 0, y: 0, w: 4, h: 2 }, widgets, widgetId: "b" });
    expect(resolved).not.toBeNull();
    expect(collides(resolved!, widgets, "b")).toBe(false);
  });

  it("finds the nearest free slot near the requested position", () => {
    const widgets = [widget("a", 0, 0, 4, 2)];
    const slot = nearestFreeSlot({ x: 0, y: 0, w: 4, h: 2 }, widgets, "b");
    expect(slot).not.toBeNull();
    expect(collides(slot!, widgets, "b")).toBe(false);
  });

  it("prefers a slot directly below over a far slot on the requested row", () => {
    // Row 0 is free only at x=10 (distance 10). Directly below the requested
    // column is free at distance 1 — that is the slot a user expects on drop.
    const widgets = [widget("a", 0, 0, 10, 1)];
    expect(nearestFreeSlot({ x: 0, y: 0, w: 2, h: 1 }, widgets, "b")).toEqual({
      x: 0,
      y: 1,
      w: 2,
      h: 1,
    });
  });

  it("never proposes a row past the store's last accepted row", () => {
    // A tall widget occupying the bottom band: any fallback slot must still satisfy
    // y <= 499, or the optimistic drop is rejected by the server and snaps back.
    const widgets = [widget("a", 0, 495, 12, 5)];
    const slot = nearestFreeSlot({ x: 0, y: 498, w: 4, h: 2 }, widgets, "b");
    expect(slot === null || slot.y + slot.h - 1 <= 499).toBe(true);
    if (slot) {
      expect(collides(slot, widgets, "b")).toBe(false);
    }
  });

  it("clamps y and h to the bounds the store enforces", () => {
    expect(clampRect({ x: 0, y: 900, w: 2, h: 40 })).toEqual({ x: 0, y: 499, w: 2, h: 20 });
    expect(nudgeRect({ x: 0, y: 499, w: 2, h: 1 }, "move", "down")).toEqual({
      x: 0,
      y: 499,
      w: 2,
      h: 1,
    });
  });

  it("renders 1-based grid placement CSS", () => {
    expect(gridPlacementStyle({ x: 0, y: 0, w: 4, h: 2 })).toBe(
      "grid-column: 1 / span 4; grid-row: 1 / span 2",
    );
    expect(gridPlacementStyle({ x: 8, y: 3, w: 4, h: 1 })).toBe(
      "grid-column: 9 / span 4; grid-row: 4 / span 1",
    );
  });

  it("counts total grid rows spanned", () => {
    expect(gridRowCount([widget("a", 0, 0, 4, 2), widget("b", 4, 1, 4, 3)])).toBe(4);
    expect(gridRowCount([])).toBe(0);
  });

  it("nudges rects by keyboard for move and resize", () => {
    expect(nudgeRect({ x: 2, y: 2, w: 4, h: 2 }, "move", "left")).toEqual({
      x: 1,
      y: 2,
      w: 4,
      h: 2,
    });
    expect(nudgeRect({ x: 0, y: 0, w: 4, h: 2 }, "move", "left")).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 2,
    });
    expect(nudgeRect({ x: 0, y: 0, w: 4, h: 2 }, "resize", "right")).toEqual({
      x: 0,
      y: 0,
      w: 5,
      h: 2,
    });
    expect(nudgeRect({ x: 0, y: 0, w: 1, h: 1 }, "resize", "left")).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it("exports the grid gap constant used by view sizing", () => {
    expect(WORKSPACE_GRID_GAP).toBeGreaterThan(0);
  });
});
