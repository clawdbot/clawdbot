/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOME_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
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
        connection: { gatewayUrl: "ws://127.0.0.1:1" },
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
  it.each([false, true])(
    "captures the terminal chord once before a consuming target (defined: %s)",
    async (defined) => {
      const element = createLazyElementSpec("keyboard terminal");
      const owner = chromeOwner(configureTerminalShell(element));
      if (defined) {
        await element.loadModule();
      }
      const target = document.body.appendChild(document.createElement("div"));
      target.addEventListener("keydown", (event) => event.stopPropagation());
      const toggle = vi.fn();
      document.addEventListener("keydown", owner.handleDocumentKeydown, true);
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, toggle);
      try {
        const event = new KeyboardEvent("keydown", {
          key: "`",
          code: "Backquote",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        expect(toggle).toHaveBeenCalledOnce();
        expect(event.defaultPrevented).toBe(true);
      } finally {
        document.removeEventListener("keydown", owner.handleDocumentKeydown, true);
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, toggle);
        target.remove();
      }
    },
  );

  it("opens the Home dock from its keyboard chord only when the gateway allows it", () => {
    const shell = configureTerminalShell(createLazyElementSpec("assistant panel"));
    const gateway = (
      shell.runtime.context as unknown as {
        gateway: {
          connection?: { gatewayUrl: string };
          snapshot: { hello: { auth: object; features: { methods: string[] } } };
        };
      }
    ).gateway;
    gateway.connection = { gatewayUrl: "ws://127.0.0.1:1" };
    const homeToggle = vi.fn();
    window.addEventListener(HOME_PANEL_TOGGLE_EVENT, homeToggle);
    const chord = () =>
      new KeyboardEvent("keydown", {
        key: "h",
        code: "KeyH",
        metaKey: true,
        shiftKey: true,
        cancelable: true,
      });
    try {
      const owner = chromeOwner(shell);
      const denied = chord();
      owner.handleDocumentKeydown(denied);
      expect(homeToggle).not.toHaveBeenCalled();
      expect(denied.defaultPrevented).toBe(false);

      gateway.snapshot.hello.features.methods = ["chat.history", "chat.send"];
      gateway.snapshot.hello.auth = {
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      };
      const allowed = chord();
      owner.handleDocumentKeydown(allowed);
      expect(homeToggle).toHaveBeenCalledOnce();
      expect(allowed.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener(HOME_PANEL_TOGGLE_EVENT, homeToggle);
    }
  });

  it("buffers panel toggle events until the active chat pane mounts", () => {
    const terminalElement = createLazyElementSpec("session terminal panel");
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellPanelToggleState;
    shell.terminalPanelElement = terminalElement;
    shell.routeState = { routeId: "chat" };

    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, { detail: { open: true } });
    chromeOwner(shell).panels.handleDeferredTerminalToggle(event);

    expect(customElements.get(terminalElement.tagName)).toBeUndefined();
    expect(takeSessionPanelToggle("terminal")).toBe(event);
  });

  it.each(["context", "document"])(
    "does not repeat a dismissed restoration until the %s lifecycle resets",
    async (lifecycle) => {
      vi.stubGlobal("localStorage", createStorageMock());
      localStorage.setItem("openclaw.terminal.panel.v1", JSON.stringify({ open: true }));
      const element = createLazyElementSpec("restored terminal", {
        firstError: new Error("offline"),
      });
      const load = vi.spyOn(element, "loadModule");
      const shell = configureTerminalShell(element);
      const owner = chromeOwner(shell);
      owner.panels.restore();
      await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
      shell.lazyCustomElements.close();
      owner.panels.restore();
      await Promise.resolve();
      expect(load).toHaveBeenCalledOnce();
      expect(shell.lazyCustomElements.visibleState).toBeUndefined();
      if (lifecycle === "context") {
        owner.abandonPendingLazyActionForContext();
      } else {
        owner.preservePendingLazyActionForReload();
      }
      owner.panels.restore();
      await vi.waitFor(() => expect(customElements.get(element.tagName)).toBeDefined());
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

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
      owner.panels.handleDeferredTerminalToggle(event);

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
    const restoreListener = (restored: Event) =>
      owner.panels.handleDeferredTerminalToggle(restored);
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
