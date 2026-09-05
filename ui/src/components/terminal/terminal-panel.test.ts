/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import * as themeColor from "../../lib/theme-color.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
  type CreateOptions,
} from "./terminal-panel.test-support.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();

const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);

function mountTerminalPanel(client: TerminalGatewayClient): OpenClawTerminalPanel {
  const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
  panel.client = client;
  panel.available = true;
  document.body.append(panel);
  return panel;
}

async function startPanelWithPendingOpen(sessionKey?: string) {
  let createOptions: CreateOptions | undefined;
  createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
    createOptions = options;
    return createTerminalController();
  });
  const open = createDeferred<ReturnType<typeof terminalOpenResult>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client: TerminalGatewayClient = {
    forceReconnect: () => {},
    request: <T>(method: string, params?: unknown) => {
      requests.push({ method, params });
      return (method === "terminal.open" ? open.promise : Promise.resolve({})) as Promise<T>;
    },
    addEventListener: () => () => {},
  };
  const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
  panel.client = client;
  panel.sessionKey = sessionKey ?? null;
  panel.available = true;
  document.body.append(panel);
  panel.toggle();
  await waitForFast(() =>
    expect(requests.some(({ method }) => method === "terminal.open")).toBe(true),
  );
  return { createOptions: createOptions!, open, panel, requests };
}

describe("OpenClawTerminalPanel", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    for (const property of ["--bg", "--text", "--accent"]) {
      document.documentElement.style.removeProperty(property);
    }
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
    sessionStorage.clear();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("uses the shared surface empty state before an embedded session opens", async () => {
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.available = true;
    panel.embedded = true;
    document.body.append(panel);
    await panel.updateComplete;

    const empty = panel.renderRoot.querySelector("openclaw-panel-empty-state");
    await empty?.updateComplete;
    expect(empty?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe("Terminal");
    expect(empty?.querySelector("svg")).not.toBeNull();
  });

  it("restores persisted open state when a mounted tag upgrades lazily", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    const tagName = `test-lazy-terminal-panel-${crypto.randomUUID()}`;
    const element = document.createElement(tagName) as HTMLElement & { available: boolean };
    element.available = true;
    document.body.append(element);

    defineTestTerminalPanelElement(createGhosttyTerminalMock, tagName);
    const panel = element as unknown as OpenClawTerminalPanel;
    await panel.updateComplete;
    await waitForFast(() => expect(panel.terminalPanelOpen).toBe(true));
  });

  it.each(["restored dock", "cold embedded"])(
    "preserves a persisted catalog intent through $0 mounting without a default restore",
    async (placement) => {
      if (placement === "restored dock") {
        localStorage.setItem(
          "openclaw.terminal.panel.v1",
          JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
        );
      }
      const catalog = { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" };
      sessionStorage.setItem(
        "openclaw.terminal.actions.v1",
        JSON.stringify([{ kind: "catalog", agentId: "research", catalog }]),
      );
      createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
      const requests: Array<{ method: string; params: unknown }> = [];
      const client: TerminalGatewayClient = {
        forceReconnect: () => {},
        request: async <T>(method: string, params?: unknown) => {
          requests.push({ method, params });
          return (method === "terminal.open" ? terminalOpenResult("catalog-session") : {}) as T;
        },
        addEventListener: () => () => {},
      };
      const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
      panel.client = client;
      panel.available = true;
      panel.agentId = "research";
      document.body.append(panel);
      if (placement === "cold embedded") {
        // Defining the lazy element upgrades the closed shell before Chat mounts
        // its embedded owner. The shell must not consume that owner's intent.
        await panel.updateComplete;
        const embedded = document.createElement(
          TERMINAL_PANEL_ELEMENT_NAME,
        ) as OpenClawTerminalPanel;
        embedded.client = client;
        embedded.available = true;
        embedded.embedded = true;
        embedded.sessionKey = "agent:research:chat";
        document.body.append(embedded);
      }

      await waitForFast(() =>
        expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull(),
      );

      expect(requests.filter((entry) => entry.method === "terminal.open")).toEqual([
        {
          method: "terminal.open",
          params: { agentId: "research", cols: 100, rows: 30, catalog },
        },
      ]);
    },
  );

  it.each([
    { dock: "bottom", label: "Dock to bottom" },
    { dock: "right", label: "Dock to right" },
  ] as const)(
    "moves the persisted $dock dock into main content and back by destination",
    async ({ dock, label }) => {
      localStorage.setItem(
        "openclaw.terminal.panel.v1",
        JSON.stringify({ open: true, dock, height: 320, width: 520 }),
      );
      const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
      panel.available = true;
      document.body.append(panel);
      await panel.updateComplete;

      panel.renderRoot
        .querySelector<HTMLButtonElement>('[aria-label="Fill main content area"]')
        ?.click();
      await panel.updateComplete;

      expect(panel.renderRoot.querySelector(".tp")?.classList.contains("tp--main")).toBe(true);
      expect(panel.renderRoot.querySelector(".tp-resizer")).toBeNull();
      expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}")).toMatchObject({
        open: true,
        dock: "main",
      });

      panel.remove();
      const restored = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
      restored.available = true;
      document.body.append(restored);
      await restored.updateComplete;
      // Destinations only: the occupied main placement drops out of the
      // cluster, and leaving it is an explicit destination pick.
      expect(restored.renderRoot.querySelector('[aria-label="Fill main content area"]')).toBeNull();
      restored.renderRoot.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
      await restored.updateComplete;

      expect(restored.renderRoot.querySelector(".tp")?.classList.contains(`tp--${dock}`)).toBe(
        true,
      );
      restored.remove();
    },
  );

  it("opens new sessions for the selected agent", async () => {
    let createOptions: CreateOptions | undefined;
    createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
      createOptions = options;
      return createTerminalController();
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return terminalOpenResult("session-1") as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.agentId = "ops";
    panel.available = true;
    document.body.append(panel);

    panel.toggle();

    await waitForFast(() => {
      expect(requests[0]).toEqual({
        method: "terminal.open",
        params: { agentId: "ops", cols: 100, rows: 30 },
      });
    });
    expect(createOptions?.terminalOptions?.fontSize).toBe(11);
    expect(createOptions?.terminalOptions?.fontFamily).toContain("MesloLGLDZ Nerd Font Mono");
    expect(getComputedStyle(createOptions!.parent).caretColor).toBe("rgba(0, 0, 0, 0)");
    const styleResults = Array.isArray(OpenClawTerminalPanel.styles)
      ? OpenClawTerminalPanel.styles
      : [OpenClawTerminalPanel.styles];
    const styles = styleResults.map((style) => style.cssText).join("\n");
    expect(styles).toMatch(/\.tabstrip-new\s*\{[^}]*align-self:\s*center/u);
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.resize",
        params: { sessionId: "session-1", cols: 100, rows: 30 },
      });
    });

    createOptions?.onData?.(new TextEncoder().encode("pwd\n"));
    createOptions?.onResize?.({ columns: 120, rows: 40 });
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "pwd\n" },
      });
      expect(requests).toContainEqual({
        method: "terminal.resize",
        params: { sessionId: "session-1", cols: 120, rows: 40 },
      });
    });
  });

  it("forces a full render after hiding and showing the panel", async () => {
    const controller = createTerminalController();
    let createOptions: CreateOptions | undefined;
    createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
      createOptions = options;
      return controller;
    });
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T,
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();

    await waitForFast(() => expect(createOptions?.parent.isConnected).toBe(true));
    controller.fit.mockClear();
    controller.terminal.renderer.render.mockClear();

    panel.toggle();
    await panel.updateComplete;
    expect(createOptions?.parent.isConnected).toBe(false);

    panel.toggle();
    await panel.updateComplete;

    expect(createOptions?.parent.isConnected).toBe(true);
    expect(controller.fit).toHaveBeenCalled();
    expect(controller.terminal.renderer.render).toHaveBeenCalledWith(
      controller.terminal.wasmTerm,
      true,
      0,
      controller.terminal,
      0,
    );
  });

  it.each(["unopened", "renderer", "wasmTerm"] as const)(
    "does not resolve a palette when the terminal is unavailable: %s",
    async (unavailable) => {
      const controller = createTerminalController();
      createGhosttyTerminalMock.mockResolvedValue(controller);
      const requests: string[] = [];
      const client: TerminalGatewayClient = {
        forceReconnect: () => {},
        request: async <T>(method: string) => {
          requests.push(method);
          return (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T;
        },
        addEventListener: () => () => {},
      };
      const panel = mountTerminalPanel(client);
      if (unavailable !== "unopened") {
        panel.toggle();
        await waitForFast(() => expect(requests).toContain("terminal.resize"));
        Object.defineProperty(controller.terminal, unavailable, { value: undefined });
      } else {
        await panel.updateComplete;
      }

      const resolveColor = vi.spyOn(themeColor, "resolveThemeColor");
      try {
        document.documentElement.style.setProperty("--accent", "#123456");
        await Promise.resolve();
        await panel.updateComplete;

        expect(resolveColor).not.toHaveBeenCalled();
        if (unavailable === "unopened") {
          expect(createGhosttyTerminalMock).not.toHaveBeenCalled();
        }
      } finally {
        resolveColor.mockRestore();
      }
    },
  );

  it("keeps terminal rendering and OSC default-color replies in sync with theme tokens", async () => {
    const root = document.documentElement;
    root.style.setProperty("--bg", "#0e1015");
    root.style.setProperty("--text", "#d7dae0");
    root.style.setProperty("--accent", "#ff5c5c");
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T;
      },
      addEventListener: (nextListener) => {
        listener = nextListener;
        return () => {};
      },
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();
    await waitForFast(() => {
      expect(requests.some(({ method }) => method === "terminal.resize")).toBe(true);
    });

    const query = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b]12;?\u001b\\";
    listener?.({
      event: "terminal.data",
      payload: { sessionId: "session-1", seq: query.length, data: query },
    });

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: {
          sessionId: "session-1",
          data: "\u001b]10;rgb:d7d7/dada/e0e0\u001b\\",
        },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: {
          sessionId: "session-1",
          data: "\u001b]11;rgb:0e0e/1010/1515\u001b\\",
        },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: {
          sessionId: "session-1",
          data: "\u001b]12;rgb:ffff/5c5c/5c5c\u001b\\",
        },
      });
    });
    expect(new TextDecoder().decode(controller.write.mock.calls[0]?.[0])).toBe(query);

    controller.terminal.renderer.setTheme.mockClear();
    controller.terminal.renderer.render.mockClear();
    root.dataset.theme = "knot";
    root.style.setProperty("--bg", "#080808");
    root.style.setProperty("--text", "#e0e0e2");
    root.style.setProperty("--accent", "#14b8a6");

    await waitForFast(() => {
      expect(controller.terminal.renderer.setTheme).toHaveBeenCalledWith(
        expect.objectContaining({
          background: "#080808",
          foreground: "#e0e0e2",
          cursor: "#14b8a6",
          cursorAccent: "#080808",
          selectionBackground: "#14b8a652",
        }),
      );
      expect(controller.terminal.renderer.render).toHaveBeenCalled();
    });

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "session-1", seq: query.length * 2, data: query },
    });
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "\u001b]10;rgb:e0e0/e0e0/e2e2\u001b\\" },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "\u001b]11;rgb:0808/0808/0808\u001b\\" },
      });
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "\u001b]12;rgb:1414/b8b8/a6a6\u001b\\" },
      });
    });
  });

  it("flushes keystrokes entered while open is in flight after resize resync", async () => {
    const { createOptions, open, requests } = await startPanelWithPendingOpen();
    createOptions.onData?.(new TextEncoder().encode("first"));
    createOptions.onData?.(new TextEncoder().encode("second"));

    open.resolve(terminalOpenResult("session-1"));

    await waitForFast(() =>
      expect(requests.filter(({ method }) => method === "terminal.input")).toHaveLength(2),
    );
    expect(requests.slice(1)).toEqual([
      {
        method: "terminal.resize",
        params: { sessionId: "session-1", cols: 100, rows: 30 },
      },
      { method: "terminal.input", params: { sessionId: "session-1", data: "first" } },
      { method: "terminal.input", params: { sessionId: "session-1", data: "second" } },
    ]);
  });

  it("drops whole startup input chunks beyond the pending-input cap", async () => {
    const { createOptions, open, requests } = await startPanelWithPendingOpen();
    const accepted = "a".repeat(8 * 1024);
    createOptions.onData?.(new TextEncoder().encode(accepted));
    createOptions.onData?.(new TextEncoder().encode("overflow"));
    createOptions.onData?.(new TextEncoder().encode("after-overflow"));

    open.resolve(terminalOpenResult("session-1"));

    await waitForFast(() =>
      expect(requests.some(({ method }) => method === "terminal.input")).toBe(true),
    );
    expect(requests.filter(({ method }) => method === "terminal.input")).toEqual([
      { method: "terminal.input", params: { sessionId: "session-1", data: accepted } },
    ]);
  });

  it("discards buffered startup input when open fails", async () => {
    const { createOptions, open, requests } = await startPanelWithPendingOpen();
    createOptions.onData?.(new TextEncoder().encode("never send"));

    open.reject(new Error("terminal open refused"));

    await waitForFast(() => {
      const panel = document.querySelector(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
      expect(panel.renderRoot.querySelector(".tp-error")?.textContent).toContain(
        "terminal open refused",
      );
    });
    expect(requests.some(({ method }) => method === "terminal.input")).toBe(false);
  });

  it("closes a session-scoped terminal cancelled after its open response", async () => {
    const { open, panel, requests } = await startPanelWithPendingOpen("agent:main:chat");
    await panel.updateComplete;
    panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")?.click();

    open.resolve(terminalOpenResult("session-1"));

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: "session-1" },
      });
    });
  });

  it("reattaches persisted sessions before opening a catalog tab", async () => {
    sessionStorage.setItem("openclaw.terminal.sessions.v1", JSON.stringify(["persisted-1"]));
    createGhosttyTerminalMock
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.list") {
          return {
            sessions: [
              {
                ...terminalOpenResult("persisted-1"),
                attached: false,
                createdAtMs: 1,
              },
            ],
          } as T;
        }
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("persisted-1"),
            buffer: "persisted output",
            seq: "persisted output".length,
          } as T;
        }
        if (method === "terminal.open") {
          return {
            ...terminalOpenResult("catalog-terminal-1"),
            title: "codex resume thread",
          } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { agentId: "research", catalog },
      }),
    );

    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp")?.classList.contains("tp--main")).toBe(true);
    expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}")).toMatchObject({
      open: true,
      dock: "main",
    });

    await waitForFast(() => {
      expect(requests.filter((entry) => entry.method === "terminal.attach")).toHaveLength(1);
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(1);
    });
    expect(requests.findIndex((entry) => entry.method === "terminal.attach")).toBeLessThan(
      requests.findIndex((entry) => entry.method === "terminal.open"),
    );
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["persisted-1"]),
    );
    panel.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Dock to bottom"]')?.click();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tp")?.classList.contains("tp--bottom")).toBe(true);
  });

  it("restores a vanished persisted session as exited without replaying stale output", async () => {
    sessionStorage.setItem("openclaw.terminal.sessions.v1", JSON.stringify(["gone-1"]));
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.list") {
          return { sessions: [] } as T;
        }
        if (method === "terminal.open") {
          return terminalOpenResult("replacement-1") as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);

    panel.toggle();

    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
    });
    expect(requests.filter((entry) => entry.method === "terminal.list")).toHaveLength(1);
    expect(requests.some((entry) => entry.method === "terminal.attach")).toBe(false);
    expect(requests.some((entry) => entry.method === "terminal.open")).toBe(false);
    expect(controller.write).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe("[]");
  });

  it("keeps a persisted session exited when it disappears during attach", async () => {
    sessionStorage.setItem("openclaw.terminal.sessions.v1", JSON.stringify(["gone-1"]));
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    let listCalls = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.list") {
          listCalls += 1;
          return {
            sessions:
              listCalls === 1
                ? [{ ...terminalOpenResult("gone-1"), attached: false, createdAtMs: 1 }]
                : [],
          } as T;
        }
        if (method === "terminal.attach") {
          throw new Error('unknown terminal session "gone-1"');
        }
        if (method === "terminal.open") {
          return terminalOpenResult("replacement-1") as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);

    panel.toggle();

    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
    });
    expect(requests.filter((entry) => entry.method === "terminal.attach")).toHaveLength(1);
    expect(requests.filter((entry) => entry.method === "terminal.list")).toHaveLength(2);
    expect(requests.some((entry) => entry.method === "terminal.open")).toBe(false);
    expect(controller.write).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe("[]");
  });

  it("does not mark a live persisted session exited after a transient attach failure", async () => {
    sessionStorage.setItem("openclaw.terminal.sessions.v1", JSON.stringify(["live-1"]));
    const controllers = [createTerminalController(), createTerminalController()] as const;
    createGhosttyTerminalMock
      .mockResolvedValueOnce(controllers[0])
      .mockResolvedValueOnce(controllers[1]);
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.list") {
          return {
            sessions: [{ ...terminalOpenResult("live-1"), attached: false, createdAtMs: 1 }],
          } as T;
        }
        if (method === "terminal.attach") {
          throw new Error("gateway temporarily unavailable");
        }
        if (method === "terminal.open") {
          return terminalOpenResult("replacement-1") as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);

    panel.toggle();

    await waitForFast(() => {
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(1);
    });
    expect(requests.filter((entry) => entry.method === "terminal.list")).toHaveLength(2);
    expect(requests.filter((entry) => entry.method === "terminal.attach")).toHaveLength(1);
    expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).not.toBe("exited");
    expect(controllers[0].write).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["replacement-1"]),
    );
  });

  it("keeps the newest session picker refresh when requests finish out of order", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    type ListedSession = ReturnType<typeof terminalOpenResult> & {
      attached: boolean;
      createdAtMs: number;
    };
    const firstList = createDeferred<{ sessions: ListedSession[] }>();
    const secondList = createDeferred<{ sessions: ListedSession[] }>();
    let listCount = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: <T>(method: string) => {
        if (method === "terminal.open") {
          return Promise.resolve(terminalOpenResult("current-1")) as Promise<T>;
        }
        if (method === "terminal.list") {
          listCount += 1;
          return (listCount === 1 ? firstList.promise : secondList.promise) as Promise<T>;
        }
        return Promise.resolve({}) as Promise<T>;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();
    await waitForFast(() => expect(panel.renderRoot.querySelector(".tp-actions")).not.toBeNull());

    (
      panel.renderRoot.querySelector('[aria-label="Terminal sessions"]') as HTMLButtonElement
    ).click();
    await waitForFast(() => expect(listCount).toBe(1));
    (panel.renderRoot.querySelector(".tp-session-refresh") as HTMLButtonElement).click();
    await waitForFast(() => expect(listCount).toBe(2));

    secondList.resolve({
      sessions: [
        {
          ...terminalOpenResult("new"),
          agentId: "new-agent",
          attached: false,
          createdAtMs: 2,
        },
      ],
    });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".tp-session-menu")?.textContent).toContain(
        "new-agent",
      ),
    );
    firstList.resolve({
      sessions: [
        {
          ...terminalOpenResult("old"),
          agentId: "old-agent",
          attached: false,
          createdAtMs: 1,
        },
      ],
    });
    await Promise.resolve();
    await panel.updateComplete;

    const menu = panel.renderRoot.querySelector(".tp-session-menu")?.textContent;
    expect(menu).toContain("new-agent");
    expect(menu).not.toContain("old-agent");
  });

  it("shows a picker attach failure after the listed session disappears", async () => {
    createGhosttyTerminalMock
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController());
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        if (method === "terminal.open") {
          return terminalOpenResult("current-1") as T;
        }
        if (method === "terminal.attach") {
          throw new Error("session expired");
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();
    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
        JSON.stringify(["current-1"]),
      );
    });

    const pick = (
      panel as unknown as { attachPickedSession: (sessionId: string) => Promise<void> }
    ).attachPickedSession.bind(panel);
    await pick("expired-1");
    await panel.updateComplete;

    expect(panel.renderRoot.textContent).toContain("Could not attach terminal session");
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["current-1"]),
    );
  });

  it("queues a catalog toggle that arrives during another terminal boot", async () => {
    const firstBoot = createDeferred<ReturnType<typeof createTerminalController>>();
    createGhosttyTerminalMock
      .mockReturnValueOnce(firstBoot.promise)
      .mockResolvedValueOnce(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    let openCount = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          openCount += 1;
          return terminalOpenResult(`session-${openCount}`) as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();
    await waitForFast(() => expect(createGhosttyTerminalMock).toHaveBeenCalledOnce());
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { agentId: "research", catalog },
      }),
    );
    firstBoot.resolve(createTerminalController());

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.open",
        params: { agentId: "research", cols: 100, rows: 30, catalog },
      });
    });
    expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(2);
  });

  it("fullscreen mode auto-opens without dock chrome and survives last-tab close", async () => {
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return terminalOpenResult("session-1") as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    panel.fullscreen = true;
    document.body.append(panel);

    // No toggle: the terminal-only document opens its session on mount.
    await waitForFast(() => {
      expect(requests.some((entry) => entry.method === "terminal.open")).toBe(true);
    });
    await panel.updateComplete;
    const section = panel.renderRoot.querySelector(".tp");
    expect(section?.classList.contains("tp--fullscreen")).toBe(true);
    expect(panel.renderRoot.querySelector(".tp-resizer")).toBeNull();
    expect(panel.renderRoot.querySelector(".tp-upload")).not.toBeNull();
    expect(panel.renderRoot.querySelectorAll(".tp-actions button")).toHaveLength(1);

    // Closing the last tab must keep the panel (with its "+" button) rendered —
    // a fullscreen document has no toggle to bring a closed panel back.
    (panel.renderRoot.querySelector(".tabstrip-tab__close") as HTMLElement).click();
    await panel.updateComplete;
    expect(requests.some((entry) => entry.method === "terminal.close")).toBe(true);
    expect(panel.renderRoot.querySelector(".tp")).not.toBeNull();
    expect(panel.renderRoot.querySelector(".tabstrip-new")).not.toBeNull();
  });

  it("opens a fresh terminal after the last tab is closed", async () => {
    const controllers = [createTerminalController(), createTerminalController()] as const;
    createGhosttyTerminalMock
      .mockResolvedValueOnce(controllers[0])
      .mockResolvedValueOnce(controllers[1]);

    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let openCount = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          openCount += 1;
          return {
            sessionId: `session-${openCount}`,
            agentId: "main",
            shell: "/bin/bash",
            cwd: "/work",
            confined: false,
          } as T;
        }
        return {} as T;
      },
      addEventListener: (nextListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) {
            listener = undefined;
          }
        };
      },
    };
    const panel = mountTerminalPanel(client);

    panel.toggle();
    await waitForFast(() => {
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(1);
    });

    const staleOutput = "CLOSE_RESET_SENTINEL";
    listener?.({
      event: "terminal.data",
      payload: { sessionId: "session-1", seq: staleOutput.length, data: staleOutput },
    });
    expect(new TextDecoder().decode(controllers[0].write.mock.calls[0]?.[0])).toBe(staleOutput);

    await panel.updateComplete;
    (panel.renderRoot.querySelector(".tabstrip-tab__close") as HTMLElement).click();
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: "session-1" },
      });
    });
    expect(controllers[0].dispose).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe("[]");

    panel.toggle();
    await waitForFast(() => {
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(2);
    });
    expect(requests.some((entry) => entry.method === "terminal.attach")).toBe(false);
    expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
    expect(controllers[1].write).not.toHaveBeenCalled();
  });

  it("marks the old session exited when a replacement client no longer lists it", async () => {
    const controllers = [createTerminalController(), createTerminalController()] as const;
    createGhosttyTerminalMock
      .mockResolvedValueOnce(controllers[0])
      .mockResolvedValueOnce(controllers[1]);

    const oldRequests: string[] = [];
    const oldUnsubscribe = vi.fn();
    const oldClient: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        oldRequests.push(method);
        return (method === "terminal.open" ? terminalOpenResult("old-session") : {}) as T;
      },
      addEventListener: () => oldUnsubscribe,
    };
    const newRequests: string[] = [];
    const newClient: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        newRequests.push(method);
        if (method === "terminal.list") {
          return { sessions: [] } as T;
        }
        return (method === "terminal.open" ? terminalOpenResult("new-session") : {}) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(oldClient);
    panel.toggle();

    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toContain("old-session");
    });
    panel.client = newClient;
    await panel.updateComplete;

    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
    });
    expect(oldRequests.filter((method) => method === "terminal.open")).toHaveLength(1);
    expect(newRequests).toEqual(["terminal.list"]);
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(controllers[0].dispose).toHaveBeenCalledOnce();
    expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
    expect(controllers[1].write).not.toHaveBeenCalled();
  });

  it("discards an async boot that finishes after disconnect and reconnect", async () => {
    const staleController = createTerminalController();
    const currentController = createTerminalController();
    const staleBoot = createDeferred<typeof staleController>();
    createGhosttyTerminalMock
      .mockImplementationOnce(async () => staleBoot.promise)
      .mockResolvedValueOnce(currentController);
    const requests: string[] = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        requests.push(method);
        return (method === "terminal.open" ? terminalOpenResult("current-session") : {}) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();

    await waitForFast(() => {
      expect(createGhosttyTerminalMock).toHaveBeenCalledOnce();
    });
    const staleOptions = createGhosttyTerminalMock.mock.calls[0]![0] as CreateOptions;
    const staleHost = staleOptions.parent;
    panel.remove();
    document.body.append(panel);

    await panel.updateComplete;
    expect(createGhosttyTerminalMock).toHaveBeenCalledOnce();
    expect(requests.filter((method) => method === "terminal.open")).toHaveLength(0);
    staleBoot.resolve(staleController);

    await waitForFast(() => {
      expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
      expect(requests.filter((method) => method === "terminal.open")).toHaveLength(1);
    });

    await waitForFast(() => {
      expect(staleController.dispose).toHaveBeenCalledOnce();
    });
    expect(staleHost.isConnected).toBe(false);
    expect(requests.filter((method) => method === "terminal.open")).toHaveLength(1);
    expect(currentController.dispose).not.toHaveBeenCalled();
  });

  it("removes resize listeners when disconnected mid-drag", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T,
      addEventListener: () => () => {},
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();
    await panel.updateComplete;

    panel.renderRoot
      .querySelector(".tp-resizer")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 200 }));
    panel.remove();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20, clientY: 20 }));

    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
      "0px",
    );
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right")).toBe(
      "0px",
    );
  });

  it("retranslates cached exit state when the locale changes", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T,
      addEventListener: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
    };
    const panel = mountTerminalPanel(client);
    panel.toggle();
    await waitForFast(() => {
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toContain("session-1");
    });

    listener?.({
      event: "terminal.exit",
      payload: { sessionId: "session-1", exitCode: null, reason: "detached" },
    });
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("detached");

    await i18n.setLocale("de");
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("getrennt");
  });
});
