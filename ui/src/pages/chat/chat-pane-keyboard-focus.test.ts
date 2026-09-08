/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "./test-helpers/chat-scroll-input.ts";

describe("chat pane keyboard focus", () => {
  it.each([
    ["range", "Home", html`<input type="range" />`, false],
    ["input", "ArrowUp", html`<input />`, false],
    [
      "handled widget",
      "PageUp",
      html`<div @keydown=${(event: KeyboardEvent) => event.preventDefault()}>Widget</div>`,
      false,
    ],
    ["transcript", "Home", html`<span>History</span>`, true],
    ...nativeControlNavigationCases
      .filter(([, key]) => key === "ArrowUp" || key === "Home" || key === "PageUp")
      .map(
        ([name, key, content, controlOwned, fixture]) =>
          [name, key, content, !controlOwned, fixture] as const,
      ),
  ] as const)(
    "loads older history only when %s yields navigation",
    async (_name, key, content, loadsHistory, fixture = {}) => {
      vi.useFakeTimers();
      const request = vi.fn(async () => ({ messages: [], hasMore: false }));
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture(),
      });
      state.chatHistoryPagination = { hasMore: true, nextOffset: 2 };
      pane.historyAutoLoadBlocked = true;
      vi.stubGlobal("IntersectionObserver", undefined);
      const thread = document.createElement("div");
      render(content, thread);
      const restorePlatform = configureNativeKeyTarget(thread.firstElementChild!, fixture);
      thread.addEventListener("keydown", (event) => pane.handleTranscriptHistoryIntent(event));
      try {
        thread.firstElementChild!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            shiftKey: fixture.shiftKey,
            ctrlKey: fixture.ctrlKey,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(loadsHistory ? 1 : 0);
        expect(pane.historyAutoLoadBlocked).toBe(!loadsHistory);
      } finally {
        restorePlatform();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

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
