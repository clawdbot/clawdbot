/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updatePickers, choosePickerValue } from "../test-helpers/select-picker.ts";
import { renderChannelPicker } from "./channel-picker.ts";
import type { SelectPicker } from "./select-picker.ts";

afterEach(() => document.body.replaceChildren());

describe("renderChannelPicker", () => {
  it("renders neutral and channel artwork while preserving a missing current channel", async () => {
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
    await updatePickers(container);

    expect(
      container.querySelector('[role="option"][data-value="last"] .picker-select__leading'),
    ).toBeNull();
    expect(container.querySelector('[role="option"][data-value="telegram"] img')).not.toBeNull();
    expect(
      container.querySelector('[role="option"][data-value="retired-channel"]')?.textContent,
    ).toContain("retired-channel");
    expect(
      container.querySelector(
        '[role="option"][data-value="retired-channel"] .channels-tile--fallback',
      ),
    ).not.toBeNull();
  });

  it("honors disabled choices and reports enabled changes", async () => {
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
    await updatePickers(container);

    const picker = container.querySelector<SelectPicker>("openclaw-select-picker");
    expect(
      container
        .querySelector('[role="option"][data-value="disabled"]')
        ?.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    if (!picker) {
      return;
    }
    await choosePickerValue(picker, "disabled");
    expect(onChange).not.toHaveBeenCalled();
    await choosePickerValue(picker, "telegram");
    expect(onChange).toHaveBeenCalledWith("telegram");
  });
});
