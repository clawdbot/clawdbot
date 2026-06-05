// Control UI test helper supports modal dialog setup.
import { expect } from "vitest";
import type { OpenClawModalDialog } from "../ui/components/modal-dialog.ts";

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

export async function getRenderedModalDialog(container: HTMLElement) {
  const modal = container.querySelector<OpenClawModalDialog>("openclaw-modal-dialog");
  expect(modal).toBeInstanceOf(HTMLElement);
  if (!modal) {
    throw new Error("Expected openclaw-modal-dialog");
  }
  await modal.updateComplete;
  await nextFrame();
  const dialog = modal.shadowRoot?.querySelector("dialog");
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error("Expected rendered dialog");
  }
  return { modal, dialog };
}
