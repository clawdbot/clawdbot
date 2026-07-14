/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockPanelLayout } from "./dock-panel-layout.ts";

function createLayout(defaultDock: "bottom" | "right") {
  return createDockPanelLayout({
    storageKey: `test.dock-panel.${defaultDock}`,
    minHeight: 140,
    minWidth: 320,
    defaultDock,
    defaultHeight: 320,
    defaultWidth: 520,
  });
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("createDockPanelLayout", () => {
  it("uses the caller's default dock for missing or invalid storage", () => {
    const bottom = createLayout("bottom");
    const right = createLayout("right");

    expect(bottom.load()).toEqual(bottom.defaults);
    localStorage.setItem("test.dock-panel.right", "{invalid");
    expect(right.load()).toEqual(right.defaults);
  });

  it("restores valid layout fields and rejects invalid sizes", () => {
    const layout = createLayout("bottom");
    localStorage.setItem(
      "test.dock-panel.bottom",
      JSON.stringify({ open: true, dock: "right", height: 100, width: Number.NaN }),
    );

    expect(layout.load()).toEqual({
      open: true,
      dock: "right",
      height: layout.defaults.height,
      width: layout.defaults.width,
    });
  });

  it("caps persisted sizes to the current viewport and saves the canonical shape", () => {
    const layout = createLayout("right");
    vi.stubGlobal("innerHeight", 500);
    vi.stubGlobal("innerWidth", 750);
    layout.save({ open: true, dock: "bottom", height: 900, width: 900 });

    expect(layout.load()).toEqual({ open: true, dock: "bottom", height: 400, width: 600 });
  });
});
