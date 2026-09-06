import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
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

function missingAuthOption(): ChatModelPickerOption {
  return {
    commitValue: "openai/gpt-5.6-luna",
    disabled: true,
    isDefault: false,
    label: "GPT-5.6 Luna",
    provider: "openai",
    unavailableReason: "missing-auth",
    value: "openai/gpt-5.6-luna",
  };
}

describe("renderChatModelPicker cooldown selection (real browser)", () => {
  it("a real click on a cooldown-disabled row reaches onModelSelect", async () => {
    const onModelSelect = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
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
      expect(button?.disabled).toBe(false);

      // Real browser click — native hit-testing and event dispatch, not a
      // synthetic jsdom MouseEvent.
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onModelSelect).toHaveBeenCalledWith(
        "ollama-t440/qwen2.5-coder:14b",
        "agent:main:main",
      );
    } finally {
      container.remove();
    }
  });

  it("a missing-auth row with no setup handler stays truly unclickable", async () => {
    const onModelSelect = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      render(
        renderChatModelPicker({
          defaultModelLabel: "Default",
          disabled: false,
          modelOptions: [missingAuthOption()],
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
        '[data-chat-model-option="openai/gpt-5.6-luna"]',
      );
      expect(button?.disabled).toBe(true);

      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onModelSelect).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });
});
