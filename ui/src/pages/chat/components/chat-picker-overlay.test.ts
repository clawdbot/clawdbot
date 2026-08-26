/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
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
});
