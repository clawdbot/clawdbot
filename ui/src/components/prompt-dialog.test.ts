/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { showPromptDialog } from "./prompt-dialog.ts";

let restoreDialogPolyfill: () => void;

function promptInput(): HTMLInputElement {
  const input = document.body.querySelector("openclaw-modal-dialog input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected prompt input");
  }
  return input;
}

function promptForm(): HTMLFormElement {
  const form = document.body.querySelector("openclaw-modal-dialog form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected prompt form");
  }
  return form;
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

async function type(value: string) {
  const input = promptInput();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
}

function submitForm() {
  promptForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

const OPTIONS = {
  title: "New group",
  fieldLabel: "New group name",
  confirmLabel: "Create group",
};

describe("showPromptDialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("opens an owned dialog that takes focus and submits nothing on its own", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const opened = showPromptDialog({ ...OPTIONS, submit });
    const { dialog } = await getRenderedModalDialog(document.body);

    expect(dialog.getAttribute("aria-label")).toBe("New group");
    expect(promptInput().hasAttribute("autofocus")).toBe(true);
    expect(promptInput().value).toBe("");
    expect(findButton("Create group").disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();

    findButton("Cancel").click();
    await opened;
  });

  it("refuses whitespace-only names and trims the value it submits", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const closed = showPromptDialog({ ...OPTIONS, submit });
    await getRenderedModalDialog(document.body);

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

  it("keeps the typed name and shows why a rejected attempt failed", async () => {
    const submit = vi.fn().mockResolvedValueOnce("group catalog rejected").mockResolvedValue(null);
    const closed = showPromptDialog({ ...OPTIONS, submit });
    await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(document.body.textContent).toContain("group catalog rejected");
    expect(promptInput().value).toBe("Client work");
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();

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
    const closed = showPromptDialog({ ...OPTIONS, submit });
    const { modal } = await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    submitForm();
    expect(submit).toHaveBeenCalledOnce();
    expect(promptInput().disabled).toBe(true);

    const cancelEvent = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();

    settle(null);
    await closed;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("cancels and dismisses without running the operation", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const cancelled = showPromptDialog({ ...OPTIONS, submit });
    await getRenderedModalDialog(document.body);
    await type("Client work");

    findButton("Cancel").click();

    await cancelled;
    expect(submit).not.toHaveBeenCalled();
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();

    const dismissed = showPromptDialog({ ...OPTIONS, submit });
    const { modal } = await getRenderedModalDialog(document.body);
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));

    await dismissed;
    expect(submit).not.toHaveBeenCalled();
  });

  it("turns a thrown operation into a visible failure instead of a stuck dialog", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway exploded"))
      .mockResolvedValue(null);
    const closed = showPromptDialog({ ...OPTIONS, submit });
    await getRenderedModalDialog(document.body);

    await type("Client work");
    submitForm();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(document.body.textContent).toContain("gateway exploded");
    expect(promptInput().disabled).toBe(false);
    expect(promptInput().value).toBe("Client work");

    submitForm();
    await closed;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("drops a reentrant prompt instead of stacking dialogs", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const first = showPromptDialog({ ...OPTIONS, submit });
    const second = showPromptDialog({ ...OPTIONS, title: "Second", submit });
    await getRenderedModalDialog(document.body);

    await second;
    expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Second");

    findButton("Cancel").click();
    await first;
  });
});
