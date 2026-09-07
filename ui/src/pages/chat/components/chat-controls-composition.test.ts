import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatModelPicker } from "./chat-model-picker.ts";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";

type CompositionMode = "active" | "legacy" | "none";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function dispatchInputKey(target: Element, key: string, composition: CompositionMode) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    isComposing: composition === "active",
    key,
  });
  if (composition === "legacy") {
    Object.defineProperty(event, "keyCode", { value: 229 });
  }
  target.dispatchEvent(event);
  return event;
}

describe("chat control IME composition", () => {
  it.each([
    { composition: "active", key: "Enter" },
    { composition: "active", key: "Escape" },
    { composition: "legacy", key: "Enter" },
    { composition: "legacy", key: "Escape" },
    { composition: "none", key: "Enter" },
    { composition: "none", key: "Escape" },
  ] as const)(
    "routes session rename $key only outside $composition composition",
    ({ composition, key }) => {
      const { container, props } = mountChatPaneHeader(containers, {
        editing: true,
        renameValue: "研究",
      });
      const input = container.querySelector<HTMLInputElement>(".chat-pane__session-title-input");
      expect(input).toBeInstanceOf(HTMLInputElement);

      const event = dispatchInputKey(input!, key, composition);

      expect(event.defaultPrevented).toBe(composition === "none");
      expect(props.onCommitRename).toHaveBeenCalledTimes(
        composition === "none" && key === "Enter" ? 1 : 0,
      );
      expect(props.onCancelRename).toHaveBeenCalledTimes(
        composition === "none" && key === "Escape" ? 1 : 0,
      );
    },
  );

  it.each([
    { composition: "active", key: "Enter" },
    { composition: "active", key: "ArrowDown" },
    { composition: "active", key: "ArrowUp" },
    { composition: "legacy", key: "Enter" },
    { composition: "legacy", key: "ArrowDown" },
    { composition: "legacy", key: "ArrowUp" },
    { composition: "none", key: "Enter" },
    { composition: "none", key: "ArrowDown" },
    { composition: "none", key: "ArrowUp" },
  ] as const)(
    "routes model search $key only outside $composition composition",
    ({ composition, key }) => {
      const onModelSelect = vi.fn(async () => true);
      const container = document.createElement("div");
      containers.push(container);
      render(
        renderChatModelPicker({
          disabled: false,
          modelSelectionLocked: false,
          modelOptions: [
            {
              commitValue: "openai/alpha",
              isDefault: false,
              label: "Alpha",
              provider: "openai",
              value: "openai/alpha",
            },
            {
              commitValue: "anthropic/beta",
              isDefault: false,
              label: "Beta",
              provider: "anthropic",
              value: "anthropic/beta",
            },
          ],
          onModelSelect,
          selectedModelValue: "openai/alpha",
          sessionKey: "main",
          triggerModelLabel: "Alpha",
        }),
        container,
      );
      const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
      const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
      expect(picker).toBeInstanceOf(HTMLDetailsElement);
      expect(search).toBeInstanceOf(HTMLInputElement);
      picker!.open = true;
      search!.value = "beta";
      search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const highlighted = search!.getAttribute("aria-activedescendant");

      const event = dispatchInputKey(search!, key, composition);

      expect(event.defaultPrevented).toBe(composition === "none");
      expect(search!.getAttribute("aria-activedescendant")).toBe(highlighted);
      const selected = composition === "none" && key === "Enter";
      expect(picker!.open).toBe(!selected);
      expect(onModelSelect).toHaveBeenCalledTimes(selected ? 1 : 0);
      if (selected) {
        expect(onModelSelect).toHaveBeenCalledWith("anthropic/beta", "main");
      }
    },
  );
});
