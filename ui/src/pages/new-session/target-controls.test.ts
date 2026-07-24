import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderStartAsDraftToggle } from "./target-controls.ts";

describe("start-as-draft control", () => {
  it("renders a labeled checkbox and reports the selected state", () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    render(renderStartAsDraftToggle({ checked: false, disabled: false, onChange }), container);

    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(container.textContent).toContain("Start as draft");
    expect(input?.checked).toBe(false);
    if (!input) {
      throw new Error("expected draft checkbox");
    }
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
