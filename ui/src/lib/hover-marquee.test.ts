import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHoverMarqueeFromEvent, stopHoverMarqueeFromEvent } from "./hover-marquee.ts";

function enter(row: HTMLElement) {
  row.addEventListener("mouseenter", startHoverMarqueeFromEvent, { once: true });
  row.dispatchEvent(new MouseEvent("mouseenter"));
}

function leave(row: HTMLElement) {
  row.addEventListener("mouseleave", stopHoverMarqueeFromEvent, { once: true });
  row.dispatchEvent(new MouseEvent("mouseleave"));
}

function buildRow(params: { textWidth: number; labelWidth: number }) {
  const row = document.createElement("div");
  const label = document.createElement("span");
  label.className = "hover-marquee";
  label.textContent = "Fix stale iMessage group-allowlist warning copy";
  row.append(label);
  document.body.append(row);
  Object.defineProperty(label, "clientWidth", { value: params.labelWidth });
  Object.defineProperty(label, "scrollWidth", { value: params.textWidth });
  return { row, label };
}

describe("hover marquee", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("waits before scrolling overflowing labels by the clipped distance", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    enter(row);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-140px");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("1750ms");
    vi.advanceTimersByTime(499);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
    leave(row);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
  });

  it("cancels the delayed scroll when hover ends early", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    enter(row);
    vi.advanceTimersByTime(250);
    leave(row);
    vi.advanceTimersByTime(250);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
  });

  it("keeps short scroll distances readable with a minimum duration", () => {
    const { row, label } = buildRow({ textWidth: 190, labelWidth: 180 });
    enter(row);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-10px");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("300ms");
  });

  it("supports a faster delayed reveal beyond a faded edge", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    label.dataset.hoverMarqueeDelay = "250";
    label.dataset.hoverMarqueeExtraShift = "18";
    enter(row);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-158px");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("1975ms");
    vi.advanceTimersByTime(249);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
  });

  it("leaves labels that fit untouched", () => {
    const { row, label } = buildRow({ textWidth: 120, labelWidth: 180 });
    enter(row);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("");
  });

  it("ignores hosts without a marquee label", () => {
    const row = document.createElement("div");
    expect(() => {
      enter(row);
      leave(row);
    }).not.toThrow();
  });

  it("remeasures an active marquee when its available width changes", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const callbackObserver: ResizeObserver = {
      observe() {},
      unobserve() {},
      disconnect() {},
    };
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    let labelWidth = 180;
    const row = document.createElement("div");
    row.className = "session-row-host";
    Object.defineProperty(row, "matches", {
      value: (selector: string) => selector === ":hover",
    });
    const label = document.createElement("span");
    label.className = "hover-marquee";
    label.textContent = "Fix stale iMessage group-allowlist warning copy";
    row.append(label);
    document.body.append(row);
    Object.defineProperty(label, "clientWidth", { get: () => labelWidth });
    Object.defineProperty(label, "scrollWidth", { value: 320 });

    enter(row);
    vi.advanceTimersByTime(500);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-140px");
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);

    labelWidth = 120;
    const resizeEntry = {
      target: label,
      borderBoxSize: [],
      contentBoxSize: [],
      contentRect: label.getBoundingClientRect(),
      devicePixelContentBoxSize: [],
    } satisfies ResizeObserverEntry;
    if (!resizeCallback) {
      throw new Error("Expected the marquee to observe its label");
    }
    resizeCallback([resizeEntry], callbackObserver);

    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-200px");
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
  });
});
