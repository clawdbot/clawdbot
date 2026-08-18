/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { takeSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type TestOptionalCustomElement,
} from "./app-host.test-support.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";

type ShellPanelToggleState = {
  browserPanelElement: TestOptionalCustomElement;
  custodianPanelElement: TestOptionalCustomElement;
  handleDeferredBrowserToggle: (event: Event) => void;
  handleDeferredCustodianToggle: (event: Event) => void;
  handleDeferredTerminalToggle: (event: Event) => void;
  routeState: { routeId: string };
  runtime: { context: ApplicationContext };
  terminalPanelElement: TestOptionalCustomElement;
};

afterEach(() => {
  resetAppHostTestGlobals();
});

describe("OpenClaw shell panel toggles", () => {
  it("delivers first panel toggles after their lazy modules load", async () => {
    const terminalElement = createLazyElementSpec("terminal panel");
    const browserElement = createLazyElementSpec("browser panel");
    const custodianElement = createLazyElementSpec("custodian panel");
    const terminalToggle = vi.fn();
    const browserToggle = vi.fn();
    const custodianToggle = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellPanelToggleState;
    shell.terminalPanelElement = terminalElement;
    shell.browserPanelElement = browserElement;
    shell.custodianPanelElement = custodianElement;
    shell.runtime = {
      context: {
        gateway: {
          snapshot: {
            phase: "connected",
            client: {},
            hello: {
              auth: { role: "operator", scopes: ["operator.admin"] },
              features: { methods: ["terminal.open", "browser.request", "openclaw.chat"] },
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
    Object.defineProperty(shell, "querySelector", {
      configurable: true,
      value: (selector: string) => {
        if (selector === terminalElement.tagName) {
          return { handleToggleRequest: terminalToggle };
        }
        if (selector === browserElement.tagName) {
          return { handleToggleRequest: browserToggle };
        }
        if (selector === custodianElement.tagName) {
          return { handleToggleRequest: custodianToggle };
        }
        return null;
      },
    });
    const terminalEvent = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, {
      detail: { dock: "right", open: true },
    });
    const browserEvent = new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT);
    const custodianEvent = new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT);

    shell.handleDeferredTerminalToggle(terminalEvent);
    shell.handleDeferredBrowserToggle(browserEvent);
    shell.handleDeferredCustodianToggle(custodianEvent);

    await vi.waitFor(() => {
      expect(terminalToggle).toHaveBeenCalledWith(terminalEvent);
      expect(browserToggle).toHaveBeenCalledWith(browserEvent);
      expect(custodianToggle).toHaveBeenCalledWith(custodianEvent);
    });
  });

  it("buffers panel toggle events until the active chat pane mounts", () => {
    const terminalElement = createLazyElementSpec("session terminal panel");
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellPanelToggleState;
    shell.terminalPanelElement = terminalElement;
    shell.routeState = { routeId: "chat" };

    const event = new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT, { detail: { open: true } });
    shell.handleDeferredTerminalToggle(event);

    expect(customElements.get(terminalElement.tagName)).toBeUndefined();
    expect(takeSessionPanelToggle("terminal")).toBe(event);
  });
});
