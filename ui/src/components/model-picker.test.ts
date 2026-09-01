/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderModelPicker } from "./model-picker.ts";

describe("renderModelPicker", () => {
  it("renders provider details and caller sentinels while preserving an unknown current model", () => {
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

    expect(container.querySelector('wa-option[value=""] [slot="start"]')).toBeNull();
    const openai = container.querySelector('wa-option[value="openai/gpt-5.6-luna"]');
    expect(openai?.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(openai?.textContent).toContain("Fast · 128k");
    expect(openai?.hasAttribute("disabled")).toBe(true);
    expect(container.querySelector('wa-option[value="legacy/model"]')?.textContent).toContain(
      "legacy/model",
    );
  });

  it("reveals free-form entry without leaking its internal option value", () => {
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

    const customOption = Array.from(container.querySelectorAll("wa-option")).find(
      (option) => option.textContent?.trim() === "Custom model…",
    );
    const picker = container.querySelector<HTMLElement & { value: string }>("wa-select");
    const input = container.querySelector<HTMLInputElement>("input");
    expect(customOption).not.toBeNull();
    expect(input?.hidden).toBe(true);
    if (!customOption || !picker || !input) {
      return;
    }
    Object.defineProperty(picker, "value", {
      configurable: true,
      value: customOption.getAttribute("value"),
    });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    Reflect.deleteProperty(picker, "value");
    expect(input.hidden).toBe(false);

    input.value = "vendor/model with spaces";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("vendor/model with spaces");
    expect(onChange).not.toHaveBeenCalledWith(customOption.getAttribute("value"));
  });
});
