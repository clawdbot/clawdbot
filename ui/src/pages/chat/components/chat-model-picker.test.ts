/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";
import { renderChatModelPicker } from "./chat-model-picker.ts";

function cooldownOption(): ChatModelPickerOption {
  return {
    commitValue: "ollama-t440/qwen2.5-coder:14b",
    disabled: true,
    isDefault: false,
    label: "Loki",
    provider: "ollama-t440",
    unavailableReason: "cooldown",
    value: "ollama-t440/qwen2.5-coder:14b",
  };
}

describe("renderChatModelPicker cooldown selection", () => {
  it("commits a cooldown-disabled model when its row is clicked", () => {
    const onModelSelect = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    render(
      renderChatModelPicker({
        defaultModelLabel: "Default",
        disabled: false,
        modelOptions: [cooldownOption()],
        modelSelectionLocked: false,
        open: true,
        selectedModelValue: "",
        sessionKey: "agent:main:main",
        sessionModelPinned: false,
        triggerModelLabel: "Thor",
        onModelSelect,
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="ollama-t440/qwen2.5-coder:14b"]',
    );
    expect(button).not.toBeNull();

    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onModelSelect).toHaveBeenCalledWith("ollama-t440/qwen2.5-coder:14b", "agent:main:main");
  });
});
