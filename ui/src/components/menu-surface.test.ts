/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";

const bridge = vi.hoisted(() => ({ available: false }));
vi.mock("../app/native-browser-host.ts", () => ({
  hasNativeBrowserBridge: () => bridge.available,
}));

let unsubscribe: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  unsubscribe?.();
  unsubscribe = undefined;
  bridge.available = false;
});

describe("promoteToPopoverTopLayer", () => {
  it("shows the element as a manual popover when the API is available", () => {
    const element = document.createElement("div");
    const showPopover = vi.fn();
    element.showPopover = showPopover;
    promoteToPopoverTopLayer(element);
    expect(element.getAttribute("popover")).toBe("manual");
    expect(showPopover).toHaveBeenCalledTimes(1);
  });

  it("falls back to in-flow rendering when the API is unavailable", () => {
    // jsdom elements have no showPopover.
    const element = document.createElement("div");
    promoteToPopoverTopLayer(element);
    expect(element.hasAttribute("popover")).toBe(false);
  });

  it("falls back to in-flow rendering when showPopover throws", () => {
    const element = document.createElement("div");
    element.showPopover = vi.fn(() => {
      throw new Error("top layer unavailable");
    });
    promoteToPopoverTopLayer(element);
    expect(element.hasAttribute("popover")).toBe(false);
  });
});

describe("openclaw-menu-surface", () => {
  it("promotes itself to the top layer on every connect", () => {
    const surface = document.createElement("openclaw-menu-surface");
    const showPopover = vi.fn();
    surface.showPopover = showPopover;
    document.body.append(surface);
    expect(surface.getAttribute("popover")).toBe("manual");
    expect(showPopover).toHaveBeenCalledTimes(1);

    // Menus toggle by removing/re-adding the surface; each reopen must
    // re-enter the top layer.
    surface.remove();
    document.body.append(surface);
    expect(showPopover).toHaveBeenCalledTimes(2);
  });

  it("keeps children rendered in-flow when the popover API is unavailable", () => {
    const surface = document.createElement("openclaw-menu-surface");
    const menu = document.createElement("div");
    menu.className = "menu";
    surface.append(menu);
    document.body.append(surface);
    expect(surface.hasAttribute("popover")).toBe(false);
    expect(surface.querySelector(".menu")).toBe(menu);
  });
});

describe("native overlay occlusion for menus", () => {
  it("keeps overlapping surfaces occluded until their close or removal, including shadow roots", async () => {
    bridge.available = true;
    const changes = vi.fn();
    unsubscribe = subscribeNativeOverlayOcclusion(changes);
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const first = document.createElement("div");
    const second = document.createElement("div");
    root.append(first, second);
    first.showPopover = vi.fn();
    promoteToPopoverTopLayer(first);
    promoteToPopoverTopLayer(first);
    // Fallback surfaces must also occlude: native webviews cover in-page menus.
    promoteToPopoverTopLayer(second);
    expect(changes.mock.calls).toEqual([[false], [true]]);

    const closed = new Event("toggle");
    Object.defineProperty(closed, "newState", { value: "closed" });
    first.dispatchEvent(closed);
    expect(changes.mock.calls).toEqual([[false], [true]]);
    second.remove();
    await Promise.resolve();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);

    promoteToPopoverTopLayer(first);
    host.remove();
    await Promise.resolve();
    expect(changes.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
  });
});
