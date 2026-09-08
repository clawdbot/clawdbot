/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";

let restoreDialogPolyfill: () => void;

function tickSkipCheckbox() {
  const checkbox = document.body.querySelector<HTMLInputElement>(
    '.exec-approval-skip input[type="checkbox"]',
  );
  if (!checkbox) {
    throw new Error("Expected the skip-preference checkbox");
  }
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

describe("showConfirmDialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("renders accessible copy and resolves the selected action", async () => {
    const result = showConfirmDialog({
      title: "Delete thread?",
      message: "This cannot be undone.",
      details: "thread-1",
      confirmLabel: "Delete",
      danger: true,
    });
    const { modal, dialog } = await getRenderedModalDialog(document.body);

    expect(dialog.getAttribute("aria-label")).toBe("Delete thread?");
    expect(dialog.getAttribute("aria-description")).toBe("This cannot be undone.");
    expect(modal.textContent).toContain("thread-1");
    expect(findButton("Delete").classList.contains("danger")).toBe(true);

    findButton("Delete").click();

    await expect(result).resolves.toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("treats modal dismissal as cancellation", async () => {
    const result = showConfirmDialog({ message: "Continue?" });
    const { modal } = await getRenderedModalDialog(document.body);

    modal.dispatchEvent(new CustomEvent("modal-cancel"));

    await expect(result).resolves.toBe(false);
  });

  it("removes the dialog and cancels when its owner aborts", async () => {
    const controller = new AbortController();
    const result = showConfirmDialog({ message: "Continue?", signal: controller.signal });
    await getRenderedModalDialog(document.body);

    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("offers the opt-out only when a skip preference is supplied", async () => {
    const plain = showConfirmDialog({ message: "Continue?" });
    await getRenderedModalDialog(document.body);
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    findButton("Cancel").click();
    await expect(plain).resolves.toBe(false);

    const remember = vi.fn();
    const offered = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: false, remember },
    });
    await getRenderedModalDialog(document.body);

    expect(document.body.querySelector(".exec-approval-skip")).toBeInstanceOf(HTMLElement);
    findButton("Confirm").click();
    await expect(offered).resolves.toBe(true);
    expect(remember).not.toHaveBeenCalled();
  });

  it("remembers the opt-out only when the operator confirms with it ticked", async () => {
    const remember = vi.fn();
    const cancelled = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: false, remember },
    });
    await getRenderedModalDialog(document.body);
    tickSkipCheckbox();
    findButton("Cancel").click();

    await expect(cancelled).resolves.toBe(false);
    expect(remember).not.toHaveBeenCalled();

    const confirmed = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: false, remember },
    });
    await getRenderedModalDialog(document.body);
    tickSkipCheckbox();
    findButton("Confirm").click();

    await expect(confirmed).resolves.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
  });

  it("resolves an opted-out confirmation without rendering a modal", async () => {
    const remember = vi.fn();

    const result = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: true, remember },
    });

    await expect(result).resolves.toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    // Re-remembering a stored choice would rewrite the preference on every run.
    expect(remember).not.toHaveBeenCalled();
  });

  it("rejects a reentrant confirmation instead of stacking or replaying it", async () => {
    const first = showConfirmDialog({ title: "First", message: "First action" });
    const second = showConfirmDialog({ title: "Second", message: "Second action" });
    await getRenderedModalDialog(document.body);

    expect(document.body.textContent).toContain("First");
    expect(document.body.textContent).not.toContain("Second");
    await expect(second).resolves.toBe(false);
    findButton("Cancel").click();
    await expect(first).resolves.toBe(false);
  });
});
