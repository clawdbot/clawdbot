/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../test-helpers/modal-dialog.ts";
import "./modal-dialog.ts";

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

  it("delegates native modality and light dismissal to Web Awesome", async () => {
    const { webAwesomeDialog, dialog } = await renderModal();

    expect(webAwesomeDialog.open).toBe(true);
    expect(webAwesomeDialog.lightDismiss).toBe(true);
    expect(webAwesomeDialog.withoutHeader).toBe(true);
    expect(dialog.open).toBe(true);
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
