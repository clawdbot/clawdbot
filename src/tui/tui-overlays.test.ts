import type { Component } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createOverlayHandlers } from "./tui-overlays.js";

class DummyComponent implements Component {
  render() {
    return ["dummy"];
  }

  invalidate() {}
}

describe("createOverlayHandlers", () => {
  it("routes overlays through the TUI overlay stack", () => {
    const showOverlay = vi.fn();
    const hideOverlay = vi.fn();
    const setFocus = vi.fn();
    let open = false;

    const host = {
      showOverlay: (component: Component) => {
        open = true;
        showOverlay(component);
      },
      hideOverlay: () => {
        open = false;
        hideOverlay();
      },
      hasOverlay: () => open,
      setFocus,
    };

    const { openOverlay, closeOverlay } = createOverlayHandlers(host, new DummyComponent());
    const overlay = new DummyComponent();

    openOverlay(overlay);
    expect(showOverlay).toHaveBeenCalledWith(overlay);

    closeOverlay();
    expect(hideOverlay).toHaveBeenCalledTimes(1);
    expect(setFocus).not.toHaveBeenCalled();
  });

  it("restores focus when closing without an overlay", () => {
    const setFocus = vi.fn();
    const host = {
      showOverlay: vi.fn(),
      hideOverlay: vi.fn(),
      hasOverlay: () => false,
      setFocus,
    };
    const fallback = new DummyComponent();

    const { closeOverlay } = createOverlayHandlers(host, fallback);
    closeOverlay();

    expect(setFocus).toHaveBeenCalledWith(fallback);
  });
});
