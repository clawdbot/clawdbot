/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import "./keyboard-shortcuts-dialog.ts";

type KeyboardShortcutsTestDialog = HTMLElement & {
  isOpen: boolean;
  sendShortcut: "enter" | "modifier-enter";
  toggle(): void;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("keyboard shortcuts dialog", () => {
  it("renders grouped shortcut chips and updates the send chord when the preference changes", async () => {
    const dialog = document.body.appendChild(
      document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
    );
    dialog.toggle();
    await dialog.updateComplete;

    expect(dialog.shadowRoot?.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    expect(
      Array.from(dialog.shadowRoot?.querySelectorAll("h3") ?? [], (heading) => heading.textContent),
    ).toEqual(["General", "Chat", "Panels", "Sidebar", "Image viewer", "Approvals"]);
    const sendRow = () =>
      Array.from(dialog.shadowRoot?.querySelectorAll(".shortcut-row") ?? []).find((row) =>
        row.textContent?.includes("Send message"),
      );
    expect(Array.from(sendRow()?.querySelectorAll("kbd") ?? [], (key) => key.textContent)).toEqual([
      "Enter",
    ]);

    dialog.sendShortcut = "modifier-enter";
    await dialog.updateComplete;

    expect(Array.from(sendRow()?.querySelectorAll("kbd") ?? [], (key) => key.textContent)).toEqual([
      "Ctrl",
      "Enter",
    ]);
    dialog.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
    await dialog.updateComplete;
    expect(dialog.isOpen).toBe(false);
    expect(dialog.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("closes when the modal dispatches its Escape cancellation", async () => {
    const dialog = document.body.appendChild(
      document.createElement("openclaw-keyboard-shortcuts-dialog") as KeyboardShortcutsTestDialog,
    );
    dialog.toggle();
    await dialog.updateComplete;

    dialog.shadowRoot
      ?.querySelector("openclaw-modal-dialog")
      ?.dispatchEvent(new CustomEvent("modal-cancel"));
    await dialog.updateComplete;

    expect(dialog.isOpen).toBe(false);
  });
});
