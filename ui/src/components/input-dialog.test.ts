/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { showInputDialog } from "./input-dialog.ts";

let restoreDialogPolyfill: () => void;

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

describe("showInputDialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("renders accessible copy and resolves the submitted value", async () => {
    const result = showInputDialog({
      title: "Rename session",
      label: "Session name",
      defaultValue: "Original name",
      submitLabel: "Rename",
    });
    const { modal, dialog } = await getRenderedModalDialog(document.body);
    const input = modal.querySelector<HTMLInputElement>('input[name="value"]');

    expect(dialog.getAttribute("aria-label")).toBe("Rename session");
    expect(dialog.getAttribute("aria-description")).toBe("Session name");
    expect(input?.value).toBe("Original name");

    if (!input) {
      throw new Error("Expected text input");
    }
    input.value = "Renamed session";
    findButton("Rename").click();

    await expect(result).resolves.toBe("Renamed session");
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("treats modal dismissal as cancellation", async () => {
    const result = showInputDialog({ title: "Rename session" });
    const { modal } = await getRenderedModalDialog(document.body);

    modal.dispatchEvent(new CustomEvent("modal-cancel"));

    await expect(result).resolves.toBeNull();
  });

  it("removes the dialog and cancels when its owner aborts", async () => {
    const controller = new AbortController();
    const result = showInputDialog({ title: "Rename session", signal: controller.signal });
    await getRenderedModalDialog(document.body);

    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("rejects a reentrant input request instead of stacking or replaying it", async () => {
    const first = showInputDialog({ title: "First" });
    const second = showInputDialog({ title: "Second" });
    await getRenderedModalDialog(document.body);

    expect(document.body.textContent).toContain("First");
    expect(document.body.textContent).not.toContain("Second");
    await expect(second).resolves.toBeNull();
    findButton("Cancel").click();
    await expect(first).resolves.toBeNull();
  });
});
