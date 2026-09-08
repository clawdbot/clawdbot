/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updatePickers, choosePickerValue } from "../test-helpers/select-picker.ts";
import { renderModelPicker } from "./model-picker.ts";
import type { SelectPicker } from "./select-picker.ts";

afterEach(() => document.body.replaceChildren());

describe("renderModelPicker", () => {
  it("renders provider details and caller sentinels while preserving an unknown current model", async () => {
    const container = document.createElement("div");
    render(
      renderModelPicker({
        label: "Model",
        value: "legacy/model",
        options: [
          { value: "", label: "Automatic" },
          {
            value: "openai/gpt-5.6-luna",
            label: "GPT-5.6 Luna",
            provider: "openai",
            detail: "Fast · 128k",
            disabled: true,
          },
        ],
        onChange: vi.fn(),
      }),
      container,
    );
    await updatePickers(container);

    expect(
      container.querySelector('[role="option"][data-value=""] .picker-select__leading'),
    ).toBeNull();
    const openai = container.querySelector('[role="option"][data-value="openai/gpt-5.6-luna"]');
    expect(openai?.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(openai?.textContent).toContain("Fast · 128k");
    expect(openai?.getAttribute("aria-disabled") === "true").toBe(true);
    expect(
      container.querySelector('[role="option"][data-value="legacy/model"]')?.textContent,
    ).toContain("legacy/model");
  });

  it("reveals free-form entry without leaking its internal option value", async () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    render(
      renderModelPicker({
        label: "Model",
        value: "openai/gpt-5.6-luna",
        options: [
          { value: "", label: "Default" },
          { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai" },
        ],
        custom: { label: "Custom model…", placeholder: "provider/model" },
        onChange,
      }),
      container,
    );
    await updatePickers(container);

    const customOption = Array.from(container.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent?.trim() === "Custom model…",
    );
    const picker = container.querySelector<SelectPicker>("openclaw-select-picker");
    const input = container.querySelector<HTMLInputElement>("input");
    expect(customOption).not.toBeNull();
    expect(input?.hidden).toBe(true);
    if (!customOption || !picker || !input) {
      return;
    }
    await choosePickerValue(picker, customOption.getAttribute("data-value")!);
    expect(input.hidden).toBe(false);

    input.value = "vendor/model with spaces";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("vendor/model with spaces");
    expect(onChange).not.toHaveBeenCalledWith(customOption.getAttribute("data-value"));
  });
});
