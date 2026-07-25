// Covers TUI overlay rendering and interaction state.
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
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
    const handle = {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => true),
    } satisfies OverlayHandle;
    let open = false;

    const host = {
      showOverlay: (component: Component) => {
        open = true;
        showOverlay(component);
        return handle;
      },
      hideOverlay: () => {
        open = false;
        hideOverlay();
      },
      hasOverlay: () => open,
      setFocus,
    };

    const { openOverlay, closeOverlay } = createOverlayHandlers(
      host as unknown as Parameters<typeof createOverlayHandlers>[0],
      new DummyComponent(),
    );
    const overlay = new DummyComponent();

    expect(openOverlay(overlay)).toBe(handle);
    expect(showOverlay).toHaveBeenCalledWith(overlay);

    closeOverlay();
    expect(hideOverlay).toHaveBeenCalledTimes(1);
    expect(setFocus).not.toHaveBeenCalled();
  });

  it("closes a specific overlay without popping the topmost overlay", () => {
    const handle = {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => false),
    } satisfies OverlayHandle;
    const host = {
      showOverlay: vi.fn(() => handle),
      hideOverlay: vi.fn(),
      hasOverlay: () => true,
      setFocus: vi.fn(),
    };
    const { closeOverlay } = createOverlayHandlers(host, new DummyComponent());

    closeOverlay(handle);

    expect(handle.hide).toHaveBeenCalledTimes(1);
    expect(host.hideOverlay).not.toHaveBeenCalled();
  });

  it("restores fallback focus after nested handled overlays close", () => {
    let openCount = 2;
    const createHandle = () =>
      ({
        hide: vi.fn(() => {
          openCount -= 1;
        }),
        setHidden: vi.fn(),
        isHidden: vi.fn(() => false),
        focus: vi.fn(),
        unfocus: vi.fn(),
        isFocused: vi.fn(() => false),
      }) satisfies OverlayHandle;
    const host = {
      showOverlay: vi.fn(),
      hideOverlay: vi.fn(),
      hasOverlay: () => openCount > 0,
      setFocus: vi.fn(),
    };
    const fallback = new DummyComponent();
    const lowerOverlay = createHandle();
    const upperOverlay = createHandle();
    const { closeOverlay } = createOverlayHandlers(host, fallback);

    closeOverlay(lowerOverlay);
    expect(host.setFocus).not.toHaveBeenCalled();

    closeOverlay(upperOverlay);
    expect(host.setFocus).toHaveBeenCalledWith(fallback);
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
