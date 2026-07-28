/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);

describe("OpenClawTerminalPanel dock suppression", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("suppresses an open dock without overwriting its persisted preference", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;

    expect(panel.renderRoot.querySelector(".tp")).not.toBeNull();
    panel.suppressed = true;
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp")).toBeNull());

    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
      "0px",
    );
    expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}")).toMatchObject({
      open: true,
    });

    panel.suppressed = false;
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp")).not.toBeNull());

    expect(panel.renderRoot.querySelector(".tp")).not.toBeNull();
  });

  it("defers availability restore until suppression ends", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: string[] = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        requests.push(method);
        return (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.suppressed = true;
    document.body.append(panel);
    await panel.updateComplete;

    panel.available = true;
    await panel.updateComplete;
    await Promise.resolve();

    expect(panel.terminalPanelOpen).toBe(false);
    expect(requests).not.toContain("terminal.open");

    panel.suppressed = false;
    await panel.updateComplete;
    await waitForFast(() => expect(requests).toContain("terminal.open"));

    expect(panel.terminalPanelOpen).toBe(true);
  });

  it("mounts closed inside a takeover instead of booting a hidden session", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: string[] = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        requests.push(method);
        return (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    panel.suppressed = true;
    document.body.append(panel);
    await panel.updateComplete;
    await Promise.resolve();

    expect(panel.terminalPanelOpen).toBe(false);
    expect(requests).not.toContain("terminal.open");

    panel.suppressed = false;
    await panel.updateComplete;
    await waitForFast(() => expect(requests).toContain("terminal.open"));
  });
});
