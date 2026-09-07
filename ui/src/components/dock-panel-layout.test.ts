/* @vitest-environment jsdom */

import type { ReactiveController } from "lit";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { createDockPanelLayout, type DockPanelSide } from "./dock-panel-layout.ts";

function createControllerHost() {
  return {
    addController: vi.fn((_controller: ReactiveController) => undefined),
    removeController: vi.fn((_controller: ReactiveController) => undefined),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
    isConnected: true,
  };
}

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

  it("round-trips an opted-in main placement", () => {
    const layout = createDockPanelLayout({
      storageKey: "test.dock-panel.main",
      minHeight: 140,
      minWidth: 320,
      defaultDock: "bottom",
      supportedDocks: ["bottom", "right", "main"],
      defaultHeight: 320,
      defaultWidth: 520,
    });

    layout.save({ open: true, dock: "main", height: 320, width: 520 });

    expect(layout.load()).toEqual({ open: true, dock: "main", height: 320, width: 520 });
  });
});

describe("DockLayoutController inline columns", () => {
  it("does not reserve the viewport for an embedded dock", () => {
    const layout = createLayout("right");
    layout.save({ open: true, dock: "right", height: 320, width: 520 });
    const host = Object.assign(document.createElement("div"), {
      addController: vi.fn((_controller: ReactiveController) => undefined),
      removeController: vi.fn((_controller: ReactiveController) => undefined),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    host.setAttribute("embedded", "");
    const controller = new DockLayoutController(host, {
      layout,
      reservationPrefix: "test-embedded",
      isAvailable: () => true,
    });

    controller.hostConnected();
    controller.syncReservation();

    expect(
      document.documentElement.style.getPropertyValue("--oc-test-embedded-reserve-bottom"),
    ).toBe("0px");
    expect(
      document.documentElement.style.getPropertyValue("--oc-test-embedded-reserve-right"),
    ).toBe("0px");
    controller.hostDisconnected();
  });

  it("resizes and restores a width without reserving the global viewport", async () => {
    const layout = createDockPanelLayout({
      storageKey: "test.dock-panel.inline",
      minHeight: 140,
      minWidth: 260,
      defaultDock: "right",
      supportedDocks: ["right"],
      defaultHeight: 320,
      defaultWidth: 280,
    });
    const reservation = "--oc-test-inline-reserve-right";
    document.documentElement.style.setProperty(reservation, "17px");
    const host = createControllerHost();
    const controller = new DockLayoutController(host, {
      layout,
      reservationPrefix: "test-inline",
      isAvailable: () => true,
      maxWidth: () => 420,
      reserveViewport: false,
    });

    controller.hostConnected();
    const container = document.createElement("div");
    document.body.append(container);
    render(controller.renderResizer("test", "Resize panel"), container);
    const separator = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "resizable-divider",
    )!;
    await separator.updateComplete;
    separator.dispatchEvent(
      new CustomEvent("resize", {
        bubbles: true,
        detail: { splitRatio: 1 - 380 / window.innerWidth },
      }),
    );

    expect(controller.width).toBe(380);
    expect(localStorage.getItem("test.dock-panel.inline")).toBeNull();
    separator.dispatchEvent(new CustomEvent("resize-end", { bubbles: true }));
    expect(JSON.parse(localStorage.getItem("test.dock-panel.inline") ?? "{}")).toMatchObject({
      width: 380,
    });
    expect(document.documentElement.style.getPropertyValue(reservation)).toBe("17px");

    const restored = new DockLayoutController(createControllerHost(), {
      layout,
      reservationPrefix: "test-inline",
      isAvailable: () => true,
      maxWidth: () => 420,
      reserveViewport: false,
    });
    restored.hostConnected();
    expect(restored.width).toBe(380);
    restored.hostDisconnected();
    controller.hostDisconnected();
    container.remove();
    document.documentElement.style.removeProperty(reservation);
  });

  it("exposes keyboard-operable separator semantics for right and bottom docks", async () => {
    const layout = createLayout("right");
    const host = createControllerHost();
    const controller = new DockLayoutController(host, {
      layout,
      reservationPrefix: "test-keyboard",
      isAvailable: () => true,
    });
    const container = document.createElement("div");
    document.body.append(container);
    controller.hostConnected();

    render(controller.renderResizer("test", "Resize panel"), container);
    let separator = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      '[role="separator"]',
    )!;
    await separator.updateComplete;
    expect(separator.getAttribute("tabindex")).toBe("0");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");

    separator.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
    );
    expect(controller.width).toBeLessThan(520);

    controller.setDock("bottom", false);
    render(controller.renderResizer("test", "Resize panel"), container);
    separator = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      '[role="separator"]',
    )!;
    await separator.updateComplete;
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");

    separator.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }),
    );
    expect(controller.height).toBeGreaterThan(320);

    controller.hostDisconnected();
    container.remove();
  });
});
