/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderChatModelPickerOption,
  type ChatModelPickerOption,
} from "./chat-model-picker-options.ts";

function cooldownEntry(overrides: Partial<ChatModelPickerOption> = {}): ChatModelPickerOption {
  return {
    commitValue: "ollama-t440/qwen2.5-coder:14b",
    disabled: true,
    isDefault: false,
    label: "Loki",
    provider: "ollama-t440",
    unavailableReason: "cooldown",
    value: "ollama-t440/qwen2.5-coder:14b",
    ...overrides,
  };
}

describe("renderChatModelPickerOption cooldown handling", () => {
  it("keeps a cooldown-disabled model row clickable and selectable", () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    render(
      renderChatModelPickerOption({
        disabled: false,
        entry: cooldownEntry(),
        index: 0,
        selectedModelValue: "",
        onHighlight: () => {},
        onSelect,
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>("[data-chat-model-option]");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("still hard-disables a missing-auth model with no setup handler", () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    render(
      renderChatModelPickerOption({
        disabled: false,
        entry: cooldownEntry({ unavailableReason: "missing-auth" }),
        index: 0,
        selectedModelValue: "",
        onHighlight: () => {},
        onSelect,
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>("[data-chat-model-option]");
    expect(button?.disabled).toBe(true);

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
