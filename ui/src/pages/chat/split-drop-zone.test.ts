import { describe, expect, it } from "vitest";
import { resolveSplitDropZone, splitDropIndicatorRect } from "./split-drop-zone.ts";

const rect = { left: 100, top: 200, width: 400, height: 200 };

describe("split drop zones", () => {
  it.each([
    [110, 300, { kind: "edge", edge: "left" }],
    [490, 300, { kind: "edge", edge: "right" }],
    [300, 210, { kind: "edge", edge: "up" }],
    [300, 390, { kind: "edge", edge: "down" }],
    [300, 300, { kind: "center" }],
  ] as const)("resolves the zone at %d, %d", (x, y, expected) => {
    expect(resolveSplitDropZone(rect, x, y)).toEqual(expected);
  });

  it("chooses the nearer edge when both axes qualify", () => {
    expect(resolveSplitDropZone(rect, 120, 240)).toEqual({ kind: "edge", edge: "left" });
    expect(resolveSplitDropZone(rect, 140, 210)).toEqual({ kind: "edge", edge: "up" });
    expect(resolveSplitDropZone(rect, 460, 390)).toEqual({ kind: "edge", edge: "down" });
    expect(resolveSplitDropZone(rect, 490, 370)).toEqual({ kind: "edge", edge: "right" });
  });

  it("returns half-pane edge indicators and a full-pane center indicator", () => {
    expect(splitDropIndicatorRect(rect, { kind: "edge", edge: "left" })).toEqual({
      left: 100,
      top: 200,
      width: 200,
      height: 200,
    });
    expect(splitDropIndicatorRect(rect, { kind: "edge", edge: "right" })).toEqual({
      left: 300,
      top: 200,
      width: 200,
      height: 200,
    });
    expect(splitDropIndicatorRect(rect, { kind: "edge", edge: "up" })).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 100,
    });
    expect(splitDropIndicatorRect(rect, { kind: "edge", edge: "down" })).toEqual({
      left: 100,
      top: 300,
      width: 400,
      height: 100,
    });
    expect(splitDropIndicatorRect(rect, { kind: "center" })).toEqual(rect);
  });

  it("copies non-enumerable DOMRect fields into the indicator rect", () => {
    const domRect = Object.create(rect) as typeof rect;
    expect(splitDropIndicatorRect(domRect, { kind: "center" })).toEqual(rect);
    expect(splitDropIndicatorRect(domRect, { kind: "edge", edge: "down" })).toEqual({
      left: 100,
      top: 300,
      width: 400,
      height: 100,
    });
  });
});
