/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createDockPanelLayout, type DockPanelSide } from "./dock-panel-layout.ts";

function createLayout(defaultDock: DockPanelSide) {
  return createDockPanelLayout({
    storageKey: `test.dock-panel.${defaultDock}`,
    minHeight: 140,
    minWidth: 320,
    defaultDock,
    supportedDocks: ["bottom", "left", "right"],
    defaultHeight: 320,
    defaultWidth: 520,
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

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

  it("restores a left dock without changing existing consumers", () => {
    const layout = createLayout("right");
    localStorage.setItem(
      "test.dock-panel.right",
      JSON.stringify({ open: true, dock: "left", height: 320, width: 420 }),
    );

    expect(layout.load()).toEqual({ open: true, dock: "left", height: 320, width: 420 });
  });

  it("rejects docks unsupported by a consumer", () => {
    const layout = createDockPanelLayout({
      storageKey: "test.dock-panel.side-only",
      minHeight: 140,
      minWidth: 320,
      defaultDock: "right",
      supportedDocks: ["bottom", "right"],
      defaultHeight: 320,
      defaultWidth: 520,
    });
    localStorage.setItem(
      "test.dock-panel.side-only",
      JSON.stringify({ open: true, dock: "left", height: 320, width: 420 }),
    );

    expect(layout.load().dock).toBe("right");
  });

  it("caps persisted sizes to the current viewport and saves the canonical shape", () => {
    const layout = createLayout("right");
    vi.stubGlobal("innerHeight", 500);
    vi.stubGlobal("innerWidth", 750);
    layout.save({ open: true, dock: "bottom", height: 900, width: 900 });

    expect(layout.load()).toEqual({ open: true, dock: "bottom", height: 400, width: 600 });
  });
});
