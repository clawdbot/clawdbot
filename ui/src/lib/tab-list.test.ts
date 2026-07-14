/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTabListKeydown } from "./tab-list.ts";

function createTabs(options: { vertical?: boolean; disabledMiddle?: boolean } = {}) {
  const tabList = document.createElement("div");
  tabList.setAttribute("role", "tablist");
  if (options.vertical) {
    tabList.setAttribute("aria-orientation", "vertical");
  }
  const tabs = ["one", "two", "three"].map((id, index) => {
    const tab = document.createElement("button");
    tab.id = id;
    tab.setAttribute("role", "tab");
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.addEventListener("keydown", handleTabListKeydown);
    if (options.disabledMiddle && index === 1) {
      tab.disabled = true;
    }
    tabList.append(tab);
    return tab;
  });
  document.body.append(tabList);
  return tabs;
}

function press(tab: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  tab.dispatchEvent(event);
  return event;
}

describe("handleTabListKeydown", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("moves, activates, and wraps horizontal tabs", () => {
    const [first, second, third] = createTabs();
    const activateSecond = vi.spyOn(second!, "click");
    first!.focus();

    expect(press(first!, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(activateSecond).toHaveBeenCalledOnce();

    third!.focus();
    press(third!, "ArrowRight");
    expect(document.activeElement).toBe(first);
  });

  it("supports Home, End, vertical arrows, and skips disabled tabs", () => {
    const [first, , third] = createTabs({ vertical: true, disabledMiddle: true });
    first!.focus();
    press(first!, "ArrowDown");
    expect(document.activeElement).toBe(third);
    press(third!, "Home");
    expect(document.activeElement).toBe(first);
    press(first!, "End");
    expect(document.activeElement).toBe(third);
  });
});
