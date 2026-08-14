import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restSessionRow, revealSessionRow } from "./session-row-reveal.ts";

const LINK_RIGHT = 200;

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width } as DOMRect;
}

const renderedTextWidths = new WeakMap<Node, number>();

function buildRow(params: { textWidth: number; labelWidth: number; actionCover?: number }) {
  const row = document.createElement("div");
  const link = document.createElement("a");
  link.className = "sidebar-recent-session__link";
  const label = document.createElement("span");
  label.className = "hover-marquee";
  label.textContent = "Fix stale iMessage group-allowlist warning copy";
  const actions = document.createElement("span");
  actions.className = "session-row-actions";
  link.append(label);
  row.append(link, actions);
  document.body.append(row);
  renderedTextWidths.set(label, params.textWidth);
  Object.defineProperty(label, "clientWidth", { value: params.labelWidth });
  // As a browser reports it: the scrollable width of a label whose text fits is
  // the label, never the text. Measuring the title from here is what let a
  // five-word title declare itself covered, so the harness may not pretend
  // otherwise.
  Object.defineProperty(label, "scrollWidth", {
    value: Math.max(params.textWidth, params.labelWidth),
  });
  const cover = params.actionCover ?? 0;
  link.getBoundingClientRect = () => rect(0, LINK_RIGHT);
  actions.getBoundingClientRect = () =>
    cover > 0 ? rect(LINK_RIGHT - cover, 54) : rect(LINK_RIGHT + 8, 0);
  return { row, label };
}

describe("session row reveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom lays nothing out, so the range that measures the rendered title
    // span answers from the width the case asked for.
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const label = this.startContainer as HTMLElement;
      return rect(label.getBoundingClientRect().left, renderedTextWidths.get(label) ?? 0);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("waits before scrolling overflowing labels past the fade", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    revealSessionRow(row);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-150px");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("1500ms");
    vi.advanceTimersByTime(499);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
    restSessionRow(row, null);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
  });

  it("cancels the delayed scroll when hover ends early", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    revealSessionRow(row);
    vi.advanceTimersByTime(250);
    restSessionRow(row, null);
    vi.advanceTimersByTime(250);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
  });

  it("keeps short travel readable and long travel bounded", () => {
    const { row: shortRow, label: shortLabel } = buildRow({ textWidth: 190, labelWidth: 180 });
    revealSessionRow(shortRow);
    expect(shortLabel.style.getPropertyValue("--hover-marquee-shift")).toBe("-20px");
    expect(shortLabel.style.getPropertyValue("--hover-marquee-duration")).toBe("900ms");

    const { row: longRow, label: longLabel } = buildRow({ textWidth: 900, labelWidth: 180 });
    revealSessionRow(longRow);
    expect(longLabel.style.getPropertyValue("--hover-marquee-duration")).toBe("1600ms");
  });

  it("leaves a title that ends before the actions untouched", () => {
    // The title fills 120 of the label's flexible 180px; the actions float over
    // the last 54, which is empty. The fade still ramps at the control edge,
    // but nothing is hidden, so nothing may move.
    const { row, label } = buildRow({ textWidth: 120, labelWidth: 180, actionCover: 54 });
    revealSessionRow(row);
    expect(row.style.getPropertyValue("--session-row-action-cover")).toBe("54px");
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("");
  });

  it("travels only the text the actions and the clip actually hide", () => {
    const { row, label } = buildRow({ textWidth: 190, labelWidth: 180, actionCover: 54 });
    revealSessionRow(row);
    // The fade rides on the link box, so it ramps at the full 54px control edge.
    expect(row.style.getPropertyValue("--session-row-action-cover")).toBe("54px");
    // The traversal only owes the reader hidden text: 10px clipped by the label
    // and 34px of the overlap that lands on it, plus 10px of fade.
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-54px");
    restSessionRow(row, null);
    expect(row.style.getPropertyValue("--session-row-action-cover")).toBe("");
  });

  it("reports no overlap when the actions sit in flow beside the row", () => {
    const { row } = buildRow({ textWidth: 320, labelWidth: 180 });
    revealSessionRow(row);
    expect(row.style.getPropertyValue("--session-row-action-cover")).toBe("0px");
  });

  it("reveals an RTL title from the opposite side", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    label.style.direction = "rtl";
    revealSessionRow(row);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("150px");
  });

  it("keeps the title still under reduced motion but still measures the overlap", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    try {
      const { row, label } = buildRow({ textWidth: 320, labelWidth: 180, actionCover: 54 });
      revealSessionRow(row);
      vi.advanceTimersByTime(2000);
      expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
      expect(row.style.getPropertyValue("--session-row-action-cover")).toBe("54px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds the reveal while the other input still owns the row", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    const pin = document.createElement("button");
    row.append(pin);
    revealSessionRow(row);
    vi.advanceTimersByTime(500);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);

    // Focus landing on the row's own Pin button is not a departure.
    restSessionRow(row, pin);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);

    // Neither is the pointer leaving while the keyboard still holds the row.
    pin.focus();
    restSessionRow(row, null);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);

    pin.blur();
    restSessionRow(row, null);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(row.style.getPropertyValue("--session-row-action-cover")).toBe("");
  });

  it("ignores hosts without a marquee label", () => {
    const row = document.createElement("div");
    expect(() => {
      revealSessionRow(row);
      restSessionRow(row, null);
    }).not.toThrow();
  });
});
