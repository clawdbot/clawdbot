import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import "./modal-dialog.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

async function mountModal(host = container, variant = "", autofocus = true) {
  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Edit details";
  modal.className = variant;
  modal.style.setProperty("--wa-transition-normal", "150ms");
  const name = document.createElement("input");
  name.autofocus = autofocus;
  name.value = "Original name";
  name.setAttribute("aria-label", "Name");
  const notes = document.createElement("textarea");
  notes.setAttribute("aria-label", "Notes");
  modal.append(name, notes);
  modal.addEventListener("modal-cancel", (event) => {
    if (event.target === modal) {
      modal.hide();
    }
  });
  host.append(modal);
  const rendered = await getRenderedModalDialog(host);
  await Promise.all(rendered.dialog.getAnimations().map((animation) => animation.finished));
  return { ...rendered, name, notes };
}

describe.runIf(browserMode)("modal native focus ownership", () => {
  it.each(["", "palette", "drawer"])(
    "preserves selected content through chrome focus and retained reopen (%s)",
    async (variant) => {
      const { userEvent } = await import("vitest/browser");
      const trigger = document.createElement("button");
      trigger.textContent = "Open editor";
      container.append(trigger);
      trigger.focus();
      const { modal, dialog, name, notes } = await mountModal(container, variant);
      expect(document.activeElement).toBe(name);

      notes.focus();
      // Web Awesome's opening frame calls this real native method. It must not
      // redirect text after the operator has already selected slotted content.
      dialog.focus();
      expect(document.activeElement).toBe(notes);
      await userEvent.keyboard("First draft");
      expect(notes.value).toBe("First draft");
      expect(name.value).toBe("Original name");

      await userEvent.keyboard("{Escape}");
      await expect.poll(() => dialog.open).toBe(false);
      await expect.poll(() => document.activeElement).toBe(trigger);
      expect(modal.isConnected).toBe(true);

      modal.show();
      await expect.poll(() => dialog.open).toBe(true);
      await expect.poll(() => document.activeElement).toBe(name);
      notes.focus();
      dialog.focus();
      expect(document.activeElement).toBe(notes);
      await userEvent.keyboard(" continued");
      expect(notes.value).toBe("First draft continued");
      expect(name.value).toBe("Original name");
      expect(
        modal.shadowRoot?.querySelector("wa-dialog")?.shadowRoot?.querySelector("dialog"),
      ).toBe(dialog);
    },
  );

  it("keeps nested modal focus and dismissal inside the owning layer", async () => {
    const { userEvent } = await import("vitest/browser");
    const outer = await mountModal();
    outer.notes.focus();
    const nestedHost = document.createElement("div");
    outer.modal.append(nestedHost);
    const inner = await mountModal(nestedHost);
    expect(document.activeElement).toBe(inner.name);

    inner.notes.focus();
    inner.dialog.focus();
    expect(document.activeElement).toBe(inner.notes);
    await userEvent.keyboard("Nested draft");
    expect(inner.notes.value).toBe("Nested draft");
    expect(outer.notes.value).toBe("");

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => inner.dialog.open).toBe(false);
    await expect.poll(() => document.activeElement).toBe(outer.notes);
    expect(outer.dialog.open).toBe(true);
    outer.dialog.focus();
    expect(document.activeElement).toBe(outer.notes);
  });

  it("preserves selected content after showing inside a shadow root", async () => {
    const { userEvent } = await import("vitest/browser");
    const shadow = container.attachShadow({ mode: "open" });
    const host = document.createElement("div");
    shadow.append(host);
    const { dialog, webAwesomeDialog, name, notes } = await mountModal(host);
    expect(shadow.activeElement).toBe(name);

    notes.focus();
    dialog.focus();
    expect(shadow.activeElement).toBe(notes);
    webAwesomeDialog.dispatchEvent(new CustomEvent("wa-after-show", { bubbles: true }));
    expect(shadow.activeElement).toBe(notes);
    await userEvent.keyboard("Shadow draft");
    expect(notes.value).toBe("Shadow draft");
    expect(name.value).toBe("Original name");
  });

  it("leaves native chrome focused when there is no autofocus target or displaced field", async () => {
    const { modal, dialog } = await mountModal(container, "", false);
    expect(dialog.matches(":focus")).toBe(true);
    expect(document.activeElement).toBe(modal);
    expect(dialog.getAttribute("aria-label")).toBe("Edit details");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});
