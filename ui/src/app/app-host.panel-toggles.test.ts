/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
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
import { isBrowserPanelAvailable, isBrowserPanelSurfaceAvailable } from "./panel-availability.ts";

type ShellPanelToggleState = {
  lazyCustomElements: LazyCustomElementRequestController;
  routeState: { routeId: string };
  runtime: { context: ApplicationContext };
  terminalPanelElement: TestOptionalCustomElement;
  browserPanelElement: TestOptionalCustomElement;
};

function chromeOwner(shell: ShellPanelToggleState): ShellChromeOwner {
  return new ShellChromeOwner(shell as unknown as ShellChromeHost);
}

function configurePanelShell(
  element: TestOptionalCustomElement,
  kind: "terminal" | "browser" = "terminal",
): ShellPanelToggleState {
  window.history.replaceState(null, "", "/usage");
  const shell = document.createElement("openclaw-app-shell") as unknown as ShellPanelToggleState;
  if (kind === "browser") {
    shell.browserPanelElement = element;
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } },
    });
  } else {
    shell.terminalPanelElement = element;
  }
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
  (shell as unknown as HTMLElement).appendChild(document.createElement(element.tagName));
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
      const owner = chromeOwner(configurePanelShell(element));
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
    const shell = configurePanelShell(createLazyElementSpec("assistant panel"));
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
      const shell = configurePanelShell(element);
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

  const replayCases = [
    {
      kind: "terminal",
      eventType: TERMINAL_PANEL_TOGGLE_EVENT,
      handler: "handleDeferredTerminalToggle",
      detail: { dock: "right", open: true, terminalSessionId: "terminal-1" },
    },
    {
      kind: "browser",
      eventType: BROWSER_PANEL_TOGGLE_EVENT,
      handler: "handleDeferredBrowserToggle",
      detail: { dock: "right", open: true, url: "https://example.com/native", native: true },
    },
  ] as const;

  it.each(replayCases)(
    "retains the exact rejected $kind panel request through in-place retry",
    async ({ kind, eventType, handler, detail }) => {
      const error = new Error("panel chunk unavailable");
      const element = createLazyElementSpec(`${kind} panel`, { firstError: error });
      const toggle = vi.fn();
      const shell = configurePanelShell(element, kind);
      const owner = chromeOwner(shell);
      const event = new CustomEvent(eventType, { detail });
      window.addEventListener(eventType, toggle);

      try {
        owner.panels[handler](event);

        await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
        expect(shell.lazyCustomElements.visibleState).toMatchObject({ error });
        expect(toggle).not.toHaveBeenCalled();

        shell.lazyCustomElements.retry();

        await vi.waitFor(() => expect(toggle).toHaveBeenCalledOnce());
      } finally {
        window.removeEventListener(eventType, toggle);
      }
      const delivered = toggle.mock.calls[0]?.[0] as CustomEvent;
      expect(delivered).not.toBe(event);
      expect(delivered.type).toBe(eventType);
      expect(delivered.detail).toEqual(detail);
    },
  );

  it.each(replayCases)(
    "restores a structured $kind panel event once in a replacement shell",
    async ({ kind, eventType, handler, detail }) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const element = createLazyElementSpec(`restored ${kind}`);
      const toggle = vi.fn();
      persistLazyShellAction({ eventType, detail });

      const replacement = configurePanelShell(element, kind);
      const owner = chromeOwner(replacement);
      const restoreListener = (restored: Event) => owner.panels[handler](restored);
      const panelListener = (restored: Event) => {
        if (customElements.get(element.tagName)) {
          toggle(restored);
        }
      };
      window.addEventListener(eventType, restoreListener);
      window.addEventListener(eventType, panelListener);
      try {
        await vi.waitFor(() => {
          owner.restorePendingLazyAction();
          expect(toggle).toHaveBeenCalledOnce();
        });
      } finally {
        window.removeEventListener(eventType, restoreListener);
        window.removeEventListener(eventType, panelListener);
      }
      const restored = toggle.mock.calls[0]?.[0];
      expect(restored).toBeInstanceOf(CustomEvent);
      expect(restored?.type).toBe(eventType);
      expect((restored as CustomEvent).detail).toEqual(detail);
      expect(readLazyShellAction()).toBeNull();
    },
  );

  it.each(["connected", "reconnecting"] as const)(
    "opens a native Browser panel while the gateway is %s without enabling remote browser actions",
    async (phase) => {
      const element = createLazyElementSpec(`native browser ${phase}`);
      const shell = configurePanelShell(element, "browser");
      const snapshot = shell.runtime.context.gateway.snapshot;
      snapshot.phase = phase;
      // The existing terminal-only advertisement cannot authorize browser.request.
      expect(isBrowserPanelAvailable(snapshot)).toBe(false);
      expect(isBrowserPanelSurfaceAvailable(snapshot)).toBe(true);
      const toggle = vi.fn();
      const owner = chromeOwner(shell);
      const detail = { open: true, url: "https://example.com/article", native: true };
      window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
      try {
        owner.panels.handleDeferredBrowserToggle(
          new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, { detail }),
        );
        await vi.waitFor(() => expect(toggle).toHaveBeenCalledOnce());
        expect(toggle.mock.calls[0]?.[0].detail).toEqual(detail);
      } finally {
        window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
      }

      Reflect.deleteProperty(window, "webkit");
      expect(isBrowserPanelSurfaceAvailable(snapshot)).toBe(false);
      expect(isBrowserPanelAvailable(snapshot)).toBe(false);
    },
  );
});
