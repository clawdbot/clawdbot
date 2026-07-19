import { describe, expect, it } from "vitest";
import {
  BOARD_GRID_COLUMNS,
  BOARD_GRID_GAP,
  BOARD_GRID_ROW_HEIGHT,
  layout,
  nudge,
  previewDrag,
  resize,
  toCssPlacement,
  type BoardGridItem,
  type BoardGridRect,
} from "./grid.ts";

function item(name: string, w: number, h: number, order: number): BoardGridItem {
  return { name, w, h, order };
}

function overlaps(left: BoardGridRect, right: BoardGridRect): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  );
}

function expectValid(rects: readonly BoardGridRect[]): void {
  for (const [index, rect] of rects.entries()) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(BOARD_GRID_COLUMNS);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.w).toBeGreaterThanOrEqual(1);
    expect(rect.h).toBeGreaterThanOrEqual(1);
    for (const other of rects.slice(index + 1)) {
      expect(overlaps(rect, other), `${rect.name} overlaps ${other.name}`).toBe(false);
    }
  }
}

function expectGravityTight(rects: readonly BoardGridRect[]): void {
  for (const rect of rects) {
    if (rect.y === 0) {
      continue;
    }
    const raised = { ...rect, y: rect.y - 1 };
    expect(
      rects.some((other) => other.name !== rect.name && overlaps(raised, other)),
      `${rect.name} leaves a hole above itself`,
    ).toBe(true);
  }
}

function propertyItems(seed: number, count: number): BoardGridItem[] {
  let value = seed;
  const random = () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value;
  };
  return Array.from({ length: count }, (_entry, order) =>
    item(
      `widget-${String(order).padStart(2, "0")}`,
      (random() % 18) - 2,
      (random() % 28) - 3,
      order,
    ),
  );
}

describe("board grid layout", () => {
  it("exports the shared geometry constants", () => {
    expect({
      columns: BOARD_GRID_COLUMNS,
      rowHeight: BOARD_GRID_ROW_HEIGHT,
      gap: BOARD_GRID_GAP,
    }).toEqual({ columns: 12, rowHeight: 56, gap: 12 });
  });

  it("flows first-fit from left to right and then downward", () => {
    expect(layout([item("a", 6, 2, 0), item("b", 6, 1, 1), item("c", 3, 1, 2)])).toEqual([
      { name: "a", x: 0, y: 0, w: 6, h: 2 },
      { name: "b", x: 6, y: 0, w: 6, h: 1 },
      { name: "c", x: 6, y: 1, w: 3, h: 1 },
    ]);
  });

  it("is deterministic by explicit order even when input order changes", () => {
    const items = [item("third", 3, 1, 30), item("first", 4, 2, 10), item("second", 8, 1, 20)];
    expect(layout(items)).toEqual(layout(items.toReversed()));
    expect(layout(items).map((rect) => rect.name)).toEqual(["first", "second", "third"]);
  });

  it("breaks duplicate order ties by name", () => {
    expect(layout([item("z", 2, 1, 0), item("a", 2, 1, 0)]).map((rect) => rect.name)).toEqual([
      "a",
      "z",
    ]);
  });

  it("never overlaps, escapes the columns, or leaves vertical holes across generated cases", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rects = layout(propertyItems(seed, 35));
      expectValid(rects);
      expectGravityTight(rects);
    }
  });

  it("clamps invalid dimensions without mutating source items", () => {
    const items = [item("wide", 99, 0, 0), item("tall", -3, 99, 1)];
    const before = structuredClone(items);
    const rects = layout(items);
    expect(rects).toEqual([
      { name: "wide", x: 0, y: 0, w: 12, h: 1 },
      { name: "tall", x: 0, y: 1, w: 1, h: 20 },
    ]);
    expect(items).toEqual(before);
  });
});

describe("board grid drag preview", () => {
  const items = [item("a", 4, 2, 0), item("b", 4, 2, 1), item("c", 4, 2, 2)];

  it("pushes an occupied target and its followers aside", () => {
    const preview = previewDrag(items, "c", { x: 1, y: 0 });
    expect(preview.items.map((entry) => [entry.name, entry.order])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]);
    expect(preview.rects.map((rect) => rect.name)).toEqual(["c", "a", "b"]);
    expectValid(preview.rects);
  });

  it("keeps the order while the pointer remains inside the dragged rect", () => {
    expect(previewDrag(items, "b", { x: 6, y: 1 }).items.map((entry) => entry.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("resolves occupied targets before removing and compacting the moving item", () => {
    const preview = previewDrag([item("a", 6, 1, 0), item("b", 6, 1, 1), item("c", 3, 1, 2)], "a", {
      x: 6,
      y: 0,
    });
    expect(preview.items.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  });

  it("chooses the next empty-cell target by rendered row-major geometry", () => {
    const heterogeneous = [
      item("a", 1, 4, 0),
      item("b", 3, 2, 1),
      item("c", 5, 4, 2),
      item("d", 7, 2, 3),
      item("e", 1, 4, 4),
      item("f", 3, 2, 5),
      item("g", 9, 4, 6),
      item("h", 11, 2, 7),
    ];
    expect(
      previewDrag(heterogeneous, "a", { x: 10, y: 0 }).items.map((entry) => entry.name),
    ).toEqual(["b", "c", "d", "e", "a", "f", "g", "h"]);
  });

  it("appends from an empty row tail or below the board", () => {
    const tailItems = [item("a", 3, 2, 0), item("b", 3, 2, 1), item("c", 3, 2, 2)];
    expect(previewDrag(tailItems, "a", { x: 10, y: 0 }).items.map((entry) => entry.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(previewDrag(items, "a", { x: 100, y: 100 }).items.map((entry) => entry.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("is deterministic and leaves inputs unchanged", () => {
    const before = structuredClone(items);
    expect(previewDrag(items, "c", { x: 0, y: 0 })).toEqual(
      previewDrag(items, "c", { x: 0, y: 0 }),
    );
    expect(items).toEqual(before);
  });

  it("preserves compaction invariants across generated drag targets", () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const generated = propertyItems(seed, 24);
      const moving = generated[(seed * 7) % generated.length]!;
      const preview = previewDrag(generated, moving.name, {
        x: (seed * 5) % BOARD_GRID_COLUMNS,
        y: (seed * 3) % 18,
      });
      expectValid(preview.rects);
      expectGravityTight(preview.rects);
      expect(preview.items.map((entry) => entry.order)).toEqual(
        Array.from({ length: generated.length }, (_entry, order) => order),
      );
    }
  });

  it("returns a compact canonical board for an unknown item", () => {
    const preview = previewDrag([item("b", 3, 1, 5), item("a", 3, 1, 2)], "missing", {
      x: 0,
      y: 0,
    });
    expect(preview.items.map((entry) => [entry.name, entry.order])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expectValid(preview.rects);
  });
});

describe("board grid mutations", () => {
  it("resizes immutably and clamps both axes", () => {
    const items = [item("a", 3, 3, 0), item("b", 4, 4, 1)];
    expect(resize(items, "a", 40, -2)).toEqual([item("a", 12, 1, 0), item("b", 4, 4, 1)]);
    expect(items[0]).toEqual(item("a", 3, 3, 0));
  });

  it.each([
    ["left", ["b", "a", "c"]],
    ["up", ["b", "a", "c"]],
    ["right", ["a", "c", "b"]],
    ["down", ["a", "c", "b"]],
  ] as const)("nudges order %s", (direction, expected) => {
    const result = nudge(
      [item("a", 1, 1, 0), item("b", 1, 1, 1), item("c", 1, 1, 2)],
      "b",
      direction,
    );
    expect(result.map((entry) => entry.name)).toEqual(expected);
    expect(result.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });

  it("does not nudge beyond either order boundary", () => {
    const items = [item("a", 1, 1, 0), item("b", 1, 1, 1)];
    expect(nudge(items, "a", "up").map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(nudge(items, "b", "right").map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("serializes one-based CSS grid placement", () => {
    expect(toCssPlacement({ name: "chart", x: 2, y: 4, w: 5, h: 3 })).toBe(
      "grid-column: 3 / span 5; grid-row: 5 / span 3;",
    );
  });
});
