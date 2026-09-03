/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

describe("chat pane keyboard focus", () => {
  it("keeps the letter-to-composer contract when a button is focused", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.active = true;
    pane.presented = true;
    const composer = document.createElement("div");
    composer.className = "agent-chat__composer-combobox";
    const textarea = composer.appendChild(document.createElement("textarea"));
    pane.append(composer);
    const focus = vi.spyOn(textarea, "focus");
    const button = document.body.appendChild(document.createElement("button"));
    button.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
    button.focus();

    try {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );

      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      button.remove();
    }
  });

  it("distinguishes an open disclosure from an open overlay", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.active = true;
    pane.presented = true;
    const composer = document.createElement("div");
    composer.className = "agent-chat__composer-combobox";
    const textarea = composer.appendChild(document.createElement("textarea"));
    pane.append(composer);
    const focus = vi.spyOn(textarea, "focus");
    const details = document.body.appendChild(document.createElement("details"));
    details.open = true;
    const summary = details.appendChild(document.createElement("summary"));
    summary.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
    let dialog: HTMLDialogElement | null = null;

    try {
      summary.focus();
      summary.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });

      focus.mockClear();
      dialog = document.body.appendChild(document.createElement("dialog"));
      dialog.open = true;
      const dialogButton = dialog.appendChild(document.createElement("button"));
      dialogButton.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
      dialogButton.focus();
      dialogButton.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );
      expect(focus).not.toHaveBeenCalled();
    } finally {
      details.remove();
      dialog?.remove();
    }
  });

  it("does not steal typing focus from a shadow-root confirmation", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.active = true;
    pane.presented = true;
    const composer = document.createElement("div");
    composer.className = "agent-chat__composer-combobox";
    const textarea = composer.appendChild(document.createElement("textarea"));
    pane.append(composer);
    const focus = vi.spyOn(textarea, "focus");
    const container = document.body.appendChild(document.createElement("div"));
    const modal = container.appendChild(document.createElement("openclaw-modal-dialog"));
    const cancel = modal.appendChild(document.createElement("button"));

    try {
      const { dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(true);
      expect(document.querySelector("dialog[open]")).toBeNull();
      cancel.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));

      cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));

      expect(focus).not.toHaveBeenCalled();
    } finally {
      container.remove();
      restoreDialogPolyfill();
    }
  });

  it("does not steal typing focus from a light-DOM confirmation", () => {
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    pane.active = true;
    pane.presented = true;
    const composer = document.createElement("div");
    composer.className = "agent-chat__composer-combobox";
    const textarea = composer.appendChild(document.createElement("textarea"));
    pane.append(composer);
    const focus = vi.spyOn(textarea, "focus");
    const modal = document.body.appendChild(document.createElement("div"));
    modal.setAttribute("aria-modal", "true");

    try {
      pane.handleDocumentKeydown(new KeyboardEvent("keydown", { key: "x", cancelable: true }));

      expect(focus).not.toHaveBeenCalled();
    } finally {
      modal.remove();
    }
  });
});
