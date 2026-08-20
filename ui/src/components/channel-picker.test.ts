/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChannelPicker } from "./channel-picker.ts";

describe("renderChannelPicker", () => {
  it("renders neutral and channel artwork while preserving a missing current channel", () => {
    const container = document.createElement("div");
    render(
      renderChannelPicker({
        label: "Channel",
        value: "retired-channel",
        options: [
          { value: "last", label: "last", kind: "neutral" },
          { value: "telegram", label: "Telegram" },
        ],
        onChange: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector('wa-option[value="last"] [slot="start"]')).toBeNull();
    expect(container.querySelector('wa-option[value="telegram"] img')).not.toBeNull();
    expect(container.querySelector('wa-option[value="retired-channel"]')?.textContent).toContain(
      "retired-channel",
    );
    expect(
      container.querySelector('wa-option[value="retired-channel"] .channels-tile--fallback'),
    ).not.toBeNull();
  });

  it("honors disabled choices and reports enabled changes", () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    render(
      renderChannelPicker({
        label: "Channel",
        value: "telegram",
        options: [
          { value: "telegram", label: "Telegram" },
          { value: "disabled", label: "Disabled", disabled: true },
        ],
        onChange,
      }),
      container,
    );

    const picker = container.querySelector<HTMLElement & { value: string }>("wa-select");
    expect(container.querySelector('wa-option[value="disabled"]')?.hasAttribute("disabled")).toBe(
      true,
    );
    if (!picker) {
      return;
    }
    Object.defineProperty(picker, "value", { configurable: true, value: "disabled" });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    Reflect.deleteProperty(picker, "value");
    expect(onChange).not.toHaveBeenCalled();
    Object.defineProperty(picker, "value", { configurable: true, value: "telegram" });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    Reflect.deleteProperty(picker, "value");
    expect(onChange).toHaveBeenCalledWith("telegram");
  });
});
