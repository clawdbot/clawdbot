/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";

afterEach(() => {
  document.body.replaceChildren();
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
