import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
// Control UI test helper supports modal dialog setup.
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

/** Await a dialog whose owner loads it behind a lazy import, then read it. */
export async function waitForRenderedModalDialog(container: HTMLElement) {
  await vi.waitFor(() => {
    if (!container.querySelector("openclaw-modal-dialog")) {
      throw new Error("Expected openclaw-modal-dialog");
    }
  });
  return getRenderedModalDialog(container);
}

export async function waitForInputDialog(): Promise<HTMLInputElement> {
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
