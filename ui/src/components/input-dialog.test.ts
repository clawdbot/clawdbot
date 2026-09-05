/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function dialogInput(): HTMLInputElement {
  const input = document.body.querySelector('openclaw-modal-dialog input[name="value"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected text input");
  }
  return input;
}

async function type(value: string) {
  const input = dialogInput();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
}

function submitForm() {
  document.body
    .querySelector("openclaw-modal-dialog form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

const REQUIRED = {
  title: "New group",
  label: "New group name",
  submitLabel: "Create group",
  requireValue: true,
} as const;

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

  it("holds a required field closed until it has a non-blank value, then trims it", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const closed = showInputDialog({ ...REQUIRED, submit });
    await getRenderedModalDialog(document.body);

    expect(findButton("Create group").disabled).toBe(true);
    await type("   ");
    expect(findButton("Create group").disabled).toBe(true);
    submitForm();
    expect(submit).not.toHaveBeenCalled();

    await type("  Client work  ");
    expect(findButton("Create group").disabled).toBe(false);
    submitForm();

    await closed;
    expect(submit).toHaveBeenCalledExactlyOnceWith("Client work");
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("holds a rename closed on the name it started from", async () => {
    const closed = showInputDialog({
      title: 'Rename group "Research"',
      label: "Group name",
      defaultValue: "Research",
      requireValue: true,
      requireChange: true,
    });
    await getRenderedModalDialog(document.body);

    // The starting name is a no-op rename, so it never reaches the Gateway;
    // whitespace around it is the same name once trimmed.
    expect(findButton("Save").disabled).toBe(true);
    await type("  Research  ");
    expect(findButton("Save").disabled).toBe(true);
    submitForm();
    expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

    await type("Projects");
    expect(findButton("Save").disabled).toBe(false);
    submitForm();

    await expect(closed).resolves.toBe("Projects");
  });

  it("keeps the typed value and shows why a rejected attempt failed", async () => {
    const submit = vi.fn().mockResolvedValueOnce("group name exceeds 512 characters");
    submit.mockResolvedValue(null);
    const closed = showInputDialog({ ...REQUIRED, submit });
    await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(document.body.textContent).toContain("group name exceeds 512 characters");
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(dialogInput().value).toBe("Client work");

    submitForm();
    await closed;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("submits once while an attempt is in flight and blocks dismissal until it settles", async () => {
    let settle!: (message: string | null) => void;
    const submit = vi.fn().mockReturnValue(
      new Promise<string | null>((resolve) => {
        settle = resolve;
      }),
    );
    const closed = showInputDialog({ ...REQUIRED, submit });
    const { modal } = await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    submitForm();
    expect(submit).toHaveBeenCalledOnce();
    expect(dialogInput().disabled).toBe(true);

    const cancelEvent = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

    settle(null);
    await closed;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("recovers when the operation throws before it returns a promise", async () => {
    // A non-async callback that validates synchronously throws before there is
    // a promise to reject; the dialog must not latch disabled on that path.
    let failFirst = true;
    const submit = vi.fn((): Promise<string | null> => {
      if (failFirst) {
        failFirst = false;
        throw new Error("synchronous validation blew up");
      }
      return Promise.resolve(null);
    });
    const closed = showInputDialog({ ...REQUIRED, submit });
    await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(document.body.textContent).toContain("synchronous validation blew up");
    expect(dialogInput().disabled).toBe(false);
    expect(findButton("Create group").disabled).toBe(false);

    submitForm();
    await closed;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("turns a thrown operation into a visible failure instead of a stuck dialog", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("gateway exploded"));
    submit.mockResolvedValue(null);
    const closed = showInputDialog({ ...REQUIRED, submit });
    await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(document.body.textContent).toContain("gateway exploded");
    expect(dialogInput().disabled).toBe(false);
    expect(dialogInput().value).toBe("Client work");

    submitForm();
    await closed;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
