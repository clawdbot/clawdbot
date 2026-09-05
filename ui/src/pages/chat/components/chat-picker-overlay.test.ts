/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "../../../components/tooltip.ts";
import {
  ensureChatComposerPickerDismissal,
  handleChatComposerDetailsToggle,
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";

describe("chat picker overlay", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("dismisses the tooltip first with the composer listener registered before or after it", async () => {
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const picker = document.createElement("details");
    const trigger = document.createElement("summary");
    const field = document.createElement("input");
    field.value = "Retained choice";
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Choice details";
    tooltip.anchor = field;
    picker.append(trigger, field, tooltip);
    const invocationMenu = document.createElement("div");
    invocationMenu.className = "slash-menu";
    composer.append(picker, invocationMenu);
    document.body.append(composer);
    await tooltip.updateComplete;
    const popup = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
    const dismissInvocations = vi.fn();
    composer.addEventListener("openclaw-composer-dismiss-invocations", dismissInvocations);

    // First opening precedes the composer's one-time listener installation.
    // Reopening registers the tooltip after that same composer listener.
    for (let opening = 0; opening < 2; opening += 1) {
      picker.open = true;
      field.focus();
      await popup.updateComplete;
      expect(popup.open).toBe(true);
      ensureChatComposerPickerDismissal();
      dismissInvocations.mockClear();

      const claimedEscape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      claimedEscape.preventDefault();
      field.dispatchEvent(claimedEscape);
      expect(popup.open).toBe(true);
      expect(picker.open).toBe(true);
      expect(dismissInvocations).not.toHaveBeenCalled();

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(escape);
      await popup.updateComplete;
      expect(popup.open).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(picker.open).toBe(true);
      expect(dismissInvocations).not.toHaveBeenCalled();
      expect(field.value).toBe("Retained choice");
      expect(document.activeElement).toBe(field);

      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(picker.open).toBe(false);
      expect(dismissInvocations).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it("does not restore pointer focus after keyboard input takes over", () => {
    const dropdown = document.createElement("wa-dropdown");
    const trigger = document.createElement("button");
    trigger.slot = "trigger";
    dropdown.append(trigger);
    document.body.append(dropdown);

    dropdown.addEventListener("wa-show", handleChatComposerDropdownShow);
    dropdown.dispatchEvent(new Event("wa-show"));
    dropdown.addEventListener("pointerdown", markPointerOpenedChatComposerDropdown);
    trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));

    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "Enter" }),
    );

    dropdown.addEventListener("wa-after-show", restorePointerOpenedChatComposerTrigger);
    dropdown.dispatchEvent(new Event("wa-after-show"));

    expect(trigger.hasAttribute("data-chat-pointer-restored-focus")).toBe(false);
  });

  it("returns Escape focus to the picker’s own trigger", () => {
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const settings = document.createElement("div");
    settings.className = "chat-controls__model-settings";
    const modelPicker = document.createElement("details");
    modelPicker.className = "chat-controls__model-picker";
    const modelTrigger = document.createElement("summary");
    modelPicker.append(modelTrigger);
    const effortPicker = document.createElement("details");
    effortPicker.className = "chat-controls__effort-picker";
    const effortTrigger = document.createElement("summary");
    const effortControl = document.createElement("input");
    effortPicker.append(effortTrigger, effortControl);
    settings.append(modelPicker, effortPicker);
    composer.append(settings);
    document.body.append(composer);

    effortPicker.open = true;
    effortPicker.addEventListener("toggle", handleChatComposerDetailsToggle);
    onTestFinished(() =>
      effortPicker.removeEventListener("toggle", handleChatComposerDetailsToggle),
    );
    effortPicker.dispatchEvent(new Event("toggle"));
    effortControl.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(effortPicker.open).toBe(false);
    expect(document.activeElement).toBe(effortTrigger);
  });

  it("keeps ancestor pickers open and dismisses nested menus from the inside out", () => {
    const composer = document.createElement("div");
    composer.className = "agent-chat__input";
    const model = document.createElement("details");
    const modelTrigger = document.createElement("summary");
    const dropdown = document.createElement("wa-dropdown");
    const accountTrigger = document.createElement("button");
    accountTrigger.slot = "trigger";
    dropdown.append(accountTrigger);
    model.append(modelTrigger, dropdown);
    const peer = document.createElement("details");
    composer.append(model, peer);
    document.body.append(composer);
    model.open = peer.open = true;
    dropdown.setAttribute("open", "");
    dropdown.addEventListener("wa-show", handleChatComposerDropdownShow);
    dropdown.dispatchEvent(new Event("wa-show"));

    expect(model.open).toBe(true);
    expect(peer.open).toBe(false);
    accountTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.hasAttribute("open")).toBe(false);
    expect(model.open).toBe(true);
    expect(document.activeElement).toBe(accountTrigger);

    accountTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(model.open).toBe(false);
    expect(document.activeElement).toBe(modelTrigger);
  });
});
