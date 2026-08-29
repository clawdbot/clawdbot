/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  handleChatComposerDetailsToggle,
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";

describe("chat picker overlay", () => {
  afterEach(() => {
    document.body.replaceChildren();
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
    effortPicker.dispatchEvent(new Event("toggle"));
    effortControl.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(effortPicker.open).toBe(false);
    expect(document.activeElement).toBe(effortTrigger);
  });
});
