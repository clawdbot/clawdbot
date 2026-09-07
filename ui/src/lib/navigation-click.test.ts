import { describe, expect, it } from "vitest";
import { shouldHandleNavigationClick } from "./navigation-click.ts";

function clickEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as MouseEvent;
}

const nativeBehaviorCases = [
  ["a prevented click", { defaultPrevented: true }],
  ["a non-primary click", { button: 1 }],
  ["a Meta-modified click", { metaKey: true }],
  ["a Control-modified click", { ctrlKey: true }],
  ["a Shift-modified click", { shiftKey: true }],
  ["an Alt-modified click", { altKey: true }],
] satisfies Array<[string, Partial<MouseEvent>]>;

describe("shouldHandleNavigationClick", () => {
  it("handles an ordinary primary click", () => {
    expect(shouldHandleNavigationClick(clickEvent())).toBe(true);
  });

  it.each(nativeBehaviorCases)("preserves native behavior for %s", (_, event) => {
    expect(shouldHandleNavigationClick(clickEvent(event))).toBe(false);
  });
});
