/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import { readComposerFloor, writeComposerFloor } from "../composer-height.ts";
import "./composer-resize-handle.ts";

function stubRect(el: HTMLElement, height: number) {
  el.getBoundingClientRect = () =>
    ({ height, width: 300, top: 0, bottom: height, left: 0, right: 300, x: 0, y: 0 }) as DOMRect;
}

function mount(boxHeight = 40, scrollHeight = 40) {
  const combobox = document.createElement("div");
  combobox.className = "agent-chat__composer-combobox";
  const handle = document.createElement("composer-resize-handle");
  const textarea = document.createElement("textarea");
  Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => scrollHeight });
  stubRect(textarea, boxHeight);
  combobox.append(handle, textarea);
  document.body.append(combobox);
  return { handle, textarea };
}

describe("composer-resize-handle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("exposes the separator ARIA contract", () => {
    const { handle } = mount();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-valuemin")).toBe("36");
    expect(Number(handle.getAttribute("aria-valuemax"))).toBeGreaterThan(36);
    expect(handle.getAttribute("aria-label")).toBeTruthy();
  });

  it("marks manual mode only when a floor is set", () => {
    writeComposerFloor(220);
    const { handle } = mount();
    expect(handle.classList.contains("manual")).toBe(true);
  });

  it("ArrowUp / ArrowDown nudge the floor and persist it globally", () => {
    const { handle } = mount(40);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(readComposerFloor()).toBe(56); // 40 + 16

    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }),
    );
    expect(readComposerFloor()).toBe(104); // 56 + 48

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(readComposerFloor()).toBe(88); // 104 - 16
  });

  it("Enter resets manual mode back to auto", () => {
    writeComposerFloor(260);
    const { handle } = mount();
    expect(handle.classList.contains("manual")).toBe(true);

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(readComposerFloor()).toBeNull();
    expect(handle.classList.contains("manual")).toBe(false);
  });

  it("pointer drag past the threshold sets and persists an exact floor", () => {
    const { handle, textarea } = mount(40);
    // Synthetic PointerEvents have no live pointer; neutralize capture so jsdom
    // does not throw (we assert on the resulting floor, not on pointer capture).
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.hasPointerCapture = () => false;

    const opts = { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 } as const;
    handle.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientY: 200 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientY: 190 })); // 10px > threshold
    handle.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientY: 100 })); // 100px up total
    expect(handle.classList.contains("dragging")).toBe(true);
    handle.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientY: 100 }));

    // startHeight 40 (stubbed rect) + 100px drag-up = 140, persisted globally.
    expect(readComposerFloor()).toBe(140);
    expect(handle.classList.contains("dragging")).toBe(false);
    expect(textarea.style.height).toBe("140px");
  });

  it("double-click resets manual mode back to auto", () => {
    writeComposerFloor(260);
    const { handle } = mount();
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(readComposerFloor()).toBeNull();
    expect(handle.classList.contains("manual")).toBe(false);
  });

  it("cleans up an active drag when disconnected mid-drag", () => {
    const { handle } = mount(40);
    const releaseSpy = vi.fn();
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = releaseSpy;
    handle.hasPointerCapture = vi.fn(() => true);

    const opts = { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 } as const;
    handle.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientY: 200 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientY: 180 }));
    expect(handle.classList.contains("dragging")).toBe(true);

    handle.remove(); // triggers disconnectedCallback mid-drag
    expect(releaseSpy).toHaveBeenCalledWith(1);
    expect(handle.classList.contains("dragging")).toBe(false);
  });

  it("re-clamps the manual floor to the viewport max on resize", () => {
    writeComposerFloor(500);
    const { textarea } = mount(500);
    // jsdom innerHeight defaults to 768 → max = round(768 * 0.55) = 422.
    window.dispatchEvent(new Event("resize"));
    expect(textarea.style.height).toBe("422px");

    vi.stubGlobal("innerHeight", 400);
    window.dispatchEvent(new Event("resize"));
    expect(textarea.style.height).toBe("220px"); // round(400 * 0.55)
  });
});
