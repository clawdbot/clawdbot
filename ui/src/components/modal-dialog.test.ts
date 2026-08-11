/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../lib/toast.ts";
import {
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../test-helpers/modal-dialog.ts";
import { OpenClawModalDialog } from "./modal-dialog.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

async function renderModal() {
  render(
    html`
      <openclaw-modal-dialog
        label="Confirm action"
        description="Review the operation before continuing."
      >
        <section>
          <h2 id="modal-title">Confirm action</h2>
          <p id="modal-description">Review the operation before continuing.</p>
          <button id="first-action">First</button>
          <button id="last-action">Last</button>
        </section>
      </openclaw-modal-dialog>
    `,
    container,
  );
  return await getRenderedModalDialog(container);
}

describe("openclaw-modal-dialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
    vi.restoreAllMocks();
  });

  it("opens a labelled modal dialog with an optional description", async () => {
    const { webAwesomeDialog, dialog } = await renderModal();

    expect(dialog.open).toBe(true);
    expect(dialog.localName).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Confirm action");
    expect(dialog.getAttribute("aria-description")).toBe("Review the operation before continuing.");
    expect(dialog.getRootNode()).toBe(webAwesomeDialog.shadowRoot);
  });

  it("focuses the dialog container first", async () => {
    const focus = vi.spyOn(HTMLDialogElement.prototype, "focus");
    const { dialog } = await renderModal();

    expect(focus).toHaveBeenCalledWith();
    expect(document.activeElement).not.toBe(container.querySelector("#first-action"));
    expect(dialog.open).toBe(true);
  });

  it("focuses slotted autofocus content", async () => {
    render(
      html`<openclaw-modal-dialog label="Edit">
        <textarea id="autofocus-target" autofocus></textarea>
      </openclaw-modal-dialog>`,
      container,
    );
    await getRenderedModalDialog(container);

    expect(document.activeElement).toBe(container.querySelector("#autofocus-target"));
  });

  it("keeps focus on a field the user selected when the show animation settles", async () => {
    render(
      html`<openclaw-modal-dialog label="Edit">
        <input id="autofocus-target" autofocus />
        <textarea id="notes-field"></textarea>
      </openclaw-modal-dialog>`,
      container,
    );
    const { webAwesomeDialog } = await getRenderedModalDialog(container);
    const notes = container.querySelector<HTMLTextAreaElement>("#notes-field");
    notes?.focus();

    webAwesomeDialog.dispatchEvent(new Event("wa-after-show"));

    expect(document.activeElement).toBe(notes);
  });

  it("delegates native modality and light dismissal to Web Awesome", async () => {
    const { webAwesomeDialog, dialog } = await renderModal();

    expect(webAwesomeDialog.open).toBe(true);
    expect(webAwesomeDialog.lightDismiss).toBe(true);
    expect(webAwesomeDialog.withoutHeader).toBe(true);
    expect(dialog.open).toBe(true);
  });

  it("hands an active toast back to the app layer when it closes", async () => {
    const shell = document.createElement("div");
    shell.className = "shell";
    const appHost = document.createElement("openclaw-toast-host");
    shell.append(appHost);
    document.body.append(shell);
    try {
      const { modal } = await renderModal();
      const moveBefore = vi.spyOn(Element.prototype, "moveBefore");

      showToast({ message: "Saved" });
      modal.hide();
      await modal.updateComplete;
      await appHost.updateComplete;

      expect(moveBefore).toHaveBeenCalledWith(appHost, null);
      expect(moveBefore.mock.contexts).toContain(modal);
      expect(appHost.querySelector(".app-toast__message")?.textContent).toBe("Saved");
      expect(modal.querySelector(".app-toast")).toBeNull();
    } finally {
      shell.remove();
    }
  });

  it("keeps the navigation drawer sidebar in a full-height, shrinkable flex column", () => {
    const styles = OpenClawModalDialog.styles.cssText;

    expect(styles).toMatch(
      /:host\(\.nav-drawer\)\s+wa-dialog::part\(body\)\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;/u,
    );
    expect(styles).toMatch(
      /::slotted\(\.shell-nav-modal__content\)\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1\s+1\s+auto;[^}]*flex-direction:\s*column;[^}]*height:\s*100%;[^}]*min-height:\s*0;/u,
    );
  });

  it("keeps responsive width and maximum-width limits owned by the same variant", () => {
    const styles = OpenClawModalDialog.styles.cssText;

    expect(styles).toMatch(
      /:host\(\.fullscreen\)\s+wa-dialog::part\(dialog\)\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*20px\);/u,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?wa-dialog\s*\{[^}]*--width:\s*min\(var\(--openclaw-modal-width,\s*540px\),\s*calc\(100vw\s*-\s*24px\)\);[\s\S]*?wa-dialog::part\(dialog\)\s*\{[^}]*max-width:\s*var\(--openclaw-modal-max-width,\s*calc\(100vw\s*-\s*24px\)\);/u,
    );
    expect(styles).toMatch(
      /:host\(\.drawer\)\s+wa-dialog\s*\{[^}]*--width:\s*min\(var\(--openclaw-modal-width,\s*100vw\),\s*100vw\);/u,
    );
    expect(styles).toMatch(
      /:host\(\.drawer\)\s+wa-dialog::part\(dialog\)\s*\{[^}]*max-width:\s*100vw;/u,
    );
  });

  it("emits modal-cancel on Escape", async () => {
    const { modal, dialog } = await renderModal();
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("emits modal-cancel when the backdrop is clicked", async () => {
    const { modal, dialog } = await renderModal();
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores lifecycle events from tooltips and menus nested in the modal", async () => {
    const { modal, dialog } = await renderModal();
    const nestedSurface = container.querySelector("#first-action");
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    for (const type of ["wa-hide", "wa-after-hide", "wa-show", "wa-after-show"]) {
      nestedSurface?.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }

    expect(onCancel).not.toHaveBeenCalled();
    expect(modal.open).toBe(true);
    expect(dialog.open).toBe(true);
  });

  it("restores focus when closed and removed", async () => {
    const returnTarget = document.createElement("button");
    returnTarget.textContent = "Return";
    document.body.append(returnTarget);
    returnTarget.focus();

    await renderModal();

    render(nothing, container);
    await nextFrame();

    expect(document.activeElement).toBe(returnTarget);
    returnTarget.remove();
  });

  it("restores the explicit owner target after Web Awesome restores its original trigger", async () => {
    const originalTrigger = document.createElement("button");
    const returnTarget = document.createElement("button");
    document.body.append(originalTrigger, returnTarget);
    originalTrigger.focus();
    const { modal, webAwesomeDialog } = await renderModal();

    modal.setReturnFocusTarget(returnTarget);
    setTimeout(() => originalTrigger.focus(), 0);
    webAwesomeDialog.dispatchEvent(new Event("wa-after-hide"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(document.activeElement).toBe(returnTarget);
    originalTrigger.remove();
    returnTarget.remove();
  });

  it("suppresses Web Awesome's original-trigger restoration when the owner closes without focus", async () => {
    const originalTrigger = document.createElement("button");
    document.body.append(originalTrigger);
    originalTrigger.focus();
    const { modal, webAwesomeDialog } = await renderModal();

    modal.setReturnFocusTarget(null);
    setTimeout(() => originalTrigger.focus(), 0);
    webAwesomeDialog.dispatchEvent(new Event("wa-after-hide"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(document.activeElement).not.toBe(originalTrigger);
    originalTrigger.remove();
  });

  it("does not restore the original trigger when a suppressed modal is removed", async () => {
    const originalTrigger = document.createElement("button");
    document.body.append(originalTrigger);
    originalTrigger.focus();
    const { modal } = await renderModal();

    modal.setReturnFocusTarget(null);
    container.querySelector<HTMLElement>("#first-action")?.focus();
    render(nothing, container);
    await nextFrame();

    expect(document.activeElement).not.toBe(originalTrigger);
    originalTrigger.remove();
  });

  it("reopens the same dialog element after reconnect", async () => {
    const focus = vi.spyOn(HTMLDialogElement.prototype, "focus");
    const { modal, dialog } = await renderModal();
    const initialFocusCalls = focus.mock.calls.length;

    modal.remove();
    expect(dialog.open).toBe(false);

    container.append(modal);
    await modal.updateComplete;
    await nextFrame();

    expect(dialog.open).toBe(true);
    expect(focus.mock.calls.length).toBeGreaterThan(initialFocusCalls);
  });
});
