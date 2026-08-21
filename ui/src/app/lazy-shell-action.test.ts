/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_PALETTE_OPEN_EVENT } from "../components/command-palette-contract.ts";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type ShellKeyboardState,
  type TestOptionalCustomElement,
} from "./app-host.test-support.ts";
import "./app-host.ts";
import { DEBUG_OVERLAY_ELEMENT } from "./lazy-custom-element.ts";
import { readLazyShellAction } from "./lazy-shell-action.ts";

const storageKey = "openclaw:lazy-event";

type ShellLifecycle = {
  connectedCallback(): void;
  disconnectedCallback(): void;
};

async function withConnectedShell(shell: ShellLifecycle, run: () => void | Promise<void>) {
  shell.connectedCallback();
  try {
    await run();
  } finally {
    shell.disconnectedCallback();
  }
}

afterEach(resetAppHostTestGlobals);

describe("lazy shell action storage", () => {
  it.each([
    "{",
    JSON.stringify({ eventType: COMMAND_PALETTE_OPEN_EVENT, extra: true }),
    JSON.stringify({ eventType: "openclaw:unknown", detail: {} }),
    JSON.stringify({ eventType: TERMINAL_PANEL_TOGGLE_EVENT, detail: [] }),
  ])("discards malformed state: %s", (raw) => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(storageKey, raw);

    expect(readLazyShellAction()).toBeNull();
    expect(storage.getItem(storageKey)).toBeNull();
  });
});

describe("shell lazy events", () => {
  it("loads the debug overlay shortcut and ignores editable targets", async () => {
    const toggled = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState &
      ShellLifecycle &
      HTMLElement;
    const overlay = document.createElement(DEBUG_OVERLAY_ELEMENT.tagName) as HTMLElement & {
      toggle: () => void;
    };
    overlay.toggle = toggled;
    shell.append(overlay);
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    const shortcut = new KeyboardEvent("keydown", {
      key: "d",
      code: "KeyD",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });

    await withConnectedShell(shell, async () => {
      shell.handleDocumentKeydown(shortcut);
      expect(shortcut.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(toggled).toHaveBeenCalledOnce());

      const input = document.body.appendChild(document.createElement("input"));
      input.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          code: "KeyD",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(toggled).toHaveBeenCalledOnce();
    });
  });

  it("opens approvals after the modal module loads", async () => {
    const element = createLazyElementSpec("exec approval modal");
    const show = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellLifecycle & {
      approvalOverlay?: { show(): void };
      execApprovalElement: TestOptionalCustomElement;
      openApprovals(): void;
    };
    shell.execApprovalElement = element;
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });
    Object.defineProperty(shell, "approvalOverlay", {
      get: () => (customElements.get(element.tagName) ? { show } : undefined),
    });

    await withConnectedShell(shell, async () => {
      shell.openApprovals();
      await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    });
  });
});
