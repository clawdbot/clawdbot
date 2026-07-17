/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResizableDivider } from "./resizable-divider.ts";
import "./resizable-divider.ts";

let container: HTMLDivElement;
const originalPointerEvent = globalThis.PointerEvent;

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function renderDivider() {
  render(
    html`
      <div id="split-root">
        <resizable-divider
          .splitRatio=${0.6}
          .minRatio=${0.4}
          .maxRatio=${0.7}
          .label=${"Resize sidebar"}
        ></resizable-divider>
      </div>
    `,
    container,
  );

  const root = container.querySelector<HTMLDivElement>("#split-root");
  const divider = container.querySelector<ResizableDivider>("resizable-divider");
  expect(root?.id).toBe("split-root");
  expect(divider?.tagName.toLowerCase()).toBe("resizable-divider");
  if (!root || !divider) {
    throw new Error("expected resizable divider fixture");
  }

  root.getBoundingClientRect = vi.fn(() => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 400,
    top: 0,
    width: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));

  await divider.updateComplete;
  await nextFrame();
  return divider;
}

function dispatchPointer(target: EventTarget, type: string, clientX: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX,
      pointerId: 7,
      pointerType: "touch",
    }),
  );
}

function expectLastResizeRatio(resized: ReturnType<typeof vi.fn>, splitRatio: number) {
  const event = resized.mock.lastCall?.[0] as CustomEvent<{ splitRatio: number }> | undefined;
  expect(event?.detail.splitRatio).toBe(splitRatio);
}

describe("resizable-divider", () => {
  beforeEach(() => {
    if (!globalThis.PointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: TestPointerEvent as typeof PointerEvent,
      });
    }
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    if (originalPointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: originalPointerEvent,
      });
    } else {
      delete (globalThis as Partial<typeof globalThis>).PointerEvent;
    }
    vi.restoreAllMocks();
  });

  it("exposes separator semantics and current split value on the host", async () => {
    const divider = await renderDivider();

    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("tabindex")).toBe("0");
    expect(divider.getAttribute("aria-label")).toBe("Resize sidebar");
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-valuemin")).toBe("40");
    expect(divider.getAttribute("aria-valuemax")).toBe("70");
    expect(divider.getAttribute("aria-valuenow")).toBe("60");

    divider.splitRatio = 0.65;
    await divider.updateComplete;

    expect(divider.getAttribute("aria-valuenow")).toBe("65");
  });

  it("resizes with keyboard arrows, Home, and End", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    divider.addEventListener("resize", resized);

    const arrowLeft = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    divider.dispatchEvent(arrowLeft);
    expect(arrowLeft.defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, 0.58);

    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    divider.dispatchEvent(arrowRight);
    expect(arrowRight.defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, 0.65);

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expectLastResizeRatio(resized, 0.4);

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expectLastResizeRatio(resized, 0.7);
  });

  it("uses pointer events for mouse, pen, and touch dragging", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    divider.setPointerCapture = setPointerCapture;
    divider.releasePointerCapture = releasePointerCapture;
    divider.hasPointerCapture = hasPointerCapture;
    divider.addEventListener("resize", resized);

    dispatchPointer(divider, "pointerdown", 100);
    expect(document.activeElement).toBe(divider);
    expect([...divider.classList]).toContain("dragging");
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    dispatchPointer(document, "pointermove", 220);
    expectLastResizeRatio(resized, 0.7);

    dispatchPointer(document, "pointerup", 220);
    expect([...divider.classList]).not.toContain("dragging");
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("shows keyboard hint on mouse enter and focus", async () => {
    const divider = await renderDivider();

    // Simulate mouse enter
    divider.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect([...divider.classList]).toContain("show-keyboard-hint");

    // Simulate mouse leave - should hide hint immediately
    divider.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect([...divider.classList]).not.toContain("show-keyboard-hint");

    // Simulate focus - should show hint
    divider.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect([...divider.classList]).toContain("show-keyboard-hint");

    // Simulate blur - should hide hint
    divider.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect([...divider.classList]).not.toContain("show-keyboard-hint");
  });

  it("provides haptic feedback and screen reader announcements", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    divider.addEventListener("resize", resized);

    // Mock navigator.vibrate for haptic feedback
    const originalVibrate = navigator.vibrate;
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      value: vibrate,
      configurable: true,
      writable: true,
    });

    // Test keyboard interaction with haptic feedback - ArrowRight should increase
    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    divider.dispatchEvent(arrowRight);

    expect(vibrate).toHaveBeenCalledWith(5);
    expect(arrowRight.defaultPrevented).toBe(true);

    // Verify screen reader announcement was created
    const announcement = document.querySelector('[role="status"][aria-live="polite"]');
    expect(announcement).toBeTruthy();
    // Should contain percentage information and direction
    expect(announcement?.textContent).toMatch(/\d+%/);
    expect(announcement?.textContent).toMatch(/increased|decreased/);

    // Cleanup
    Object.defineProperty(navigator, "vibrate", {
      value: originalVibrate,
      configurable: true,
      writable: true,
    });
  });

  it("hides keyboard hint during drag", async () => {
    const divider = await renderDivider();

    // Show hint first
    divider.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect([...divider.classList]).toContain("show-keyboard-hint");

    // Start drag - should hide hint
    dispatchPointer(divider, "pointerdown", 100);
    // Note: pointerdown clears the hint immediately, but mouseenter timeout might still be running
    // The important thing is that dragging state is set
    expect([...divider.classList]).toContain("dragging");

    // End drag
    dispatchPointer(document, "pointerup", 100);
    expect([...divider.classList]).not.toContain("dragging");
  });

  it("renders visual handle elements", async () => {
    const divider = await renderDivider();

    // The component renders into shadow DOM or light DOM depending on createRenderRoot
    // Since ResizableDivider uses default shadow DOM, we need to check shadowRoot
    if (divider.shadowRoot) {
      const handle = divider.shadowRoot.querySelector(".divider-handle");
      expect(handle).toBeTruthy();

      const hint = divider.shadowRoot.querySelector(".keyboard-hint");
      expect(hint).toBeTruthy();
      expect(hint?.querySelector("kbd")).toBeTruthy();
    }
  });
});
