/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { takeSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type TestOptionalCustomElement,
} from "./app-host.test-support.ts";
import "./app-host.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";
import type { ApplicationContext } from "./context.ts";
import type { LazyCustomElementRequestController } from "./lazy-custom-element.ts";
import { persistLazyShellAction, readLazyShellAction } from "./lazy-shell-action.ts";

type ShellPanelToggleState = {
  lazyCustomElements: LazyCustomElementRequestController;
  routeState: { routeId: string };
  runtime: { context: ApplicationContext };
  terminalPanelElement: TestOptionalCustomElement;
};

function chromeOwner(shell: ShellPanelToggleState): ShellChromeOwner {
  return new ShellChromeOwner(shell as unknown as ShellChromeHost);
}

function configureTerminalShell(terminalElement: TestOptionalCustomElement): ShellPanelToggleState {
  window.history.replaceState(null, "", "/usage");
  const shell = document.createElement("openclaw-app-shell") as unknown as ShellPanelToggleState;
  shell.terminalPanelElement = terminalElement;
  shell.routeState = { routeId: "usage" };
  shell.runtime = {
    context: {
      gateway: {
        snapshot: {
          phase: "connected",
          client: {},
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["terminal.open"] },
          },
        },
      },
      config: { current: { terminalEnabled: true } },
    } as unknown as ApplicationContext,
  };
  Object.defineProperty(shell, "updateComplete", {
    configurable: true,
    get: () => Promise.resolve(true),
  });
  // The production shell keeps panel tags mounted before definition; replay is
  // gated on the rendered element, so the harness mounts the tag the same way.
  Object.defineProperty(shell, "renderRoot", {
    configurable: true,
    get: () => shell,
  });
  (shell as unknown as HTMLElement).appendChild(document.createElement(terminalElement.tagName));
  return shell;
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  resetAppHostTestGlobals();
});

describe("OpenClaw shell panel toggles", () => {
  it("buffers panel toggle events until the active chat pane mounts", () => {
    const terminalElement = createLazyElementSpec("session terminal panel");
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellPanelToggleState;
    shell.terminalPanelElement = terminalElement;
    shell.routeState = { routeId: "chat" };

    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, { detail: { open: true } });
    chromeOwner(shell).handleDeferredTerminalToggle(event);

    expect(customElements.get(terminalElement.tagName)).toBeUndefined();
    expect(takeSessionPanelToggle("terminal")).toBe(event);
  });

  it("retains the exact rejected panel request through in-place retry", async () => {
    const error = new Error("terminal chunk unavailable");
    const terminalElement = createLazyElementSpec("terminal panel", { firstError: error });
    const terminalToggle = vi.fn();
    const shell = configureTerminalShell(terminalElement);
    const owner = chromeOwner(shell);
    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
      detail: { dock: "right", open: true },
    });
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, terminalToggle);

    try {
      owner.handleDeferredTerminalToggle(event);

      await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
      expect(shell.lazyCustomElements.visibleState).toMatchObject({ error });
      expect(terminalToggle).not.toHaveBeenCalled();

      shell.lazyCustomElements.retry();

      await vi.waitFor(() => expect(terminalToggle).toHaveBeenCalledOnce());
    } finally {
      window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, terminalToggle);
    }
    const delivered = terminalToggle.mock.calls[0]?.[0] as CustomEvent;
    expect(delivered).not.toBe(event);
    expect(delivered.type).toBe(TERMINAL_PANEL_TOGGLE_EVENT);
    expect(delivered.detail).toEqual(event.detail);
  });

  it("restores a structured panel event once in a replacement shell", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const terminalElement = createLazyElementSpec("restored terminal");
    const terminalToggle = vi.fn();
    const detail = { dock: "right" as const, open: true, terminalSessionId: "terminal-1" };
    persistLazyShellAction({
      eventType: TERMINAL_PANEL_TOGGLE_EVENT,
      detail,
    });

    const replacement = configureTerminalShell(terminalElement);
    const owner = chromeOwner(replacement);
    const restoreListener = (restored: Event) => owner.handleDeferredTerminalToggle(restored);
    const panelListener = (restored: Event) => {
      if (customElements.get(terminalElement.tagName)) {
        terminalToggle(restored);
      }
    };
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, restoreListener);
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelListener);
    try {
      await vi.waitFor(() => {
        owner.restorePendingLazyAction();
        expect(terminalToggle).toHaveBeenCalledOnce();
      });
    } finally {
      window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, restoreListener);
      window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, panelListener);
    }
    const restored = terminalToggle.mock.calls[0]?.[0];
    expect(restored).toBeInstanceOf(CustomEvent);
    expect(restored?.type).toBe(TERMINAL_PANEL_TOGGLE_EVENT);
    expect((restored as CustomEvent).detail).toEqual(detail);
    expect(readLazyShellAction()).toBeNull();
  });
});
