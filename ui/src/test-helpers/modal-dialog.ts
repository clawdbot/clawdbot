import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { expect, vi } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";

type DialogMethodName = "showModal" | "close";
type DialogDescriptorSnapshot = Record<DialogMethodName, PropertyDescriptor | undefined>;

export function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function restoreDescriptor(name: DialogMethodName, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    return;
  }
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
}

export function installDialogPolyfill(): () => void {
  const snapshot: DialogDescriptorSnapshot = {
    close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
    showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  };
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  return () => {
    restoreDescriptor("showModal", snapshot.showModal);
    restoreDescriptor("close", snapshot.close);
  };
}

async function waitForDialog<T>(read: () => T): Promise<T> {
  // Lazy module loading is fixture setup, not part of the DOM readiness deadline.
  await vi.dynamicImportSettled();
  return vi.waitFor(read);
}

export function createModalDialogTestFixture(
  dismissModal: (modal: HTMLElement) => void = (modal) => {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  },
) {
  const restoreDialogPolyfill = installDialogPolyfill();
  const operations: Promise<unknown>[] = [];
  const requests: Promise<unknown>[] = [];
  const modals = new Set<HTMLElement>();
  const captureModals = () => {
    for (const modal of document.body.querySelectorAll("openclaw-modal-dialog")) {
      modals.add(modal);
    }
  };
  const observer = new MutationObserver(captureModals);
  observer.observe(document.body, { childList: true, subtree: true });
  let pendingCleanup: Promise<void> | undefined;

  function track<T>(completion: Promise<T>, work: Promise<unknown>[]) {
    work.push(completion);
    void completion.catch(() => {});
    return completion;
  }

  async function cleanup() {
    let joined = false;
    try {
      // An assertion can fail before the lazy dialog exists. Catalog completion
      // can repaint its host, so join those responses before cancelling the owner.
      await vi.dynamicImportSettled();
      await Promise.allSettled(requests);
      await vi.dynamicImportSettled();
      captureModals();
      for (const modal of modals) {
        if (modal.parentElement) {
          dismissModal(modal);
        }
      }
      const results = await Promise.allSettled(operations);
      await vi.dynamicImportSettled();
      joined = true;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Dialog operations failed during fixture cleanup");
      }
    } finally {
      observer.disconnect();
      if (joined) {
        document.body.replaceChildren();
        restoreDialogPolyfill();
      }
    }
  }

  return {
    waitFor: waitForDialog,
    track: <T>(completion: Promise<T>) => track(completion, operations),
    mockRequest: <Args extends unknown[], Result>(request: (...args: Args) => Promise<Result>) =>
      vi.fn((...args: Args) => track(request(...args), requests)),
    cleanup: () => (pendingCleanup ??= cleanup()),
  };
}

/**
 * Wait for the confirm dialog `showConfirmDialog` renders into `document.body`.
 * Returned separately from answering it so tests can mutate owner state (a
 * reconnect, an agent switch) while the decision is still pending.
 */
export function waitForConfirmDialogActions(): Promise<HTMLElement> {
  return waitForDialog(() => {
    const actions = document.body.querySelector<HTMLElement>(
      "openclaw-modal-dialog .exec-approval-actions",
    );
    if (!actions) {
      throw new Error("Expected an open confirm dialog");
    }
    return actions;
  });
}

export function answerConfirmDialog(actions: HTMLElement, choice: "confirm" | "cancel") {
  const button = actions.querySelector<HTMLButtonElement>(
    choice === "confirm" ? ".btn.danger, .btn.primary" : ".btn[autofocus]",
  );
  if (!button) {
    throw new Error(`Expected the confirm dialog's ${choice} button`);
  }
  button.click();
}

/** Await a dialog whose owner loads it behind a lazy import, then read it. */
export async function waitForRenderedModalDialog(container: HTMLElement) {
  await waitForDialog(() => {
    if (!container.querySelector("openclaw-modal-dialog")) {
      throw new Error("Expected openclaw-modal-dialog");
    }
  });
  return getRenderedModalDialog(container);
}

export async function waitForInputDialog(): Promise<HTMLInputElement> {
  await vi.dynamicImportSettled();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const input = document.body.querySelector("openclaw-modal-dialog input");
    if (input instanceof HTMLInputElement) {
      return input;
    }
    await nextFrame();
  }
  throw new Error("Expected an open input dialog");
}

export async function submitInputDialog(value: string): Promise<void> {
  const input = await waitForInputDialog();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextFrame();
  input.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

export async function getRenderedModalDialog(container: HTMLElement) {
  const modal = container.querySelector<OpenClawModalDialog>("openclaw-modal-dialog");
  expect(modal).toBeInstanceOf(HTMLElement);
  if (!modal) {
    throw new Error("Expected openclaw-modal-dialog");
  }
  await modal.updateComplete;
  await nextFrame();
  const webAwesomeDialog = modal.shadowRoot?.querySelector<WaDialog>("wa-dialog");
  expect(webAwesomeDialog).toBeInstanceOf(HTMLElement);
  if (!webAwesomeDialog) {
    throw new Error("Expected rendered Web Awesome dialog");
  }
  await webAwesomeDialog.updateComplete;
  await nextFrame();
  const dialog = webAwesomeDialog.shadowRoot?.querySelector("dialog");
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error("Expected rendered dialog");
  }
  await nextFrame();
  return { modal, webAwesomeDialog, dialog };
}
