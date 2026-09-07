/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { expect, it, vi } from "vitest";
import {
  renderContextWindowControl,
  type ChatContextWindowControlParams,
} from "./chat-context-window-control.ts";

it("keeps multi-option context selection contained and ignores current or disabled choices", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const onSelect = vi.fn(async (_next: string, _sessionKey: string) => {});
  const bubbled = vi.fn();
  host.addEventListener("click", bubbled);
  const props: ChatContextWindowControlParams = {
    options: [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "500k", label: "500K", contextWindow: 500_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ],
    selected: "1m",
    disabled: false,
    onSelect,
  };
  const paint = () => render(renderContextWindowControl(props, "agent:main:synthetic"), host);
  const click = (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
    if (!button) {
      throw new Error(`Missing context option ${label}`);
    }
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event;
  };
  try {
    paint();
    expect(host.querySelector('[aria-pressed="true"]')?.textContent?.trim()).toBe("1M");
    expect(click("1M").defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    click("200K");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("200k", "agent:main:synthetic");
    props.disabled = true;
    paint();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled),
    ).toBe(true);
    expect(click("500K").defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(bubbled).not.toHaveBeenCalled();
  } finally {
    render(nothing, host);
    host.remove();
  }
});
