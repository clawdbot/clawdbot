/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";

type CreateOptions = {
  parent: HTMLElement;
  terminalOptions?: {
    fontFamily?: string;
    theme?: { background?: string; foreground?: string };
  };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

type CreateGhosttyTerminalMock = Mock<
  (options: CreateOptions) => Promise<ReturnType<typeof createTerminalController>>
>;
type TerminalFactory = typeof import("./terminal-runtime.ts").createIsolatedGhosttyTerminal;

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();

function createTerminalController(dispose: () => void = vi.fn()) {
  const wasmTerm = {};
  const renderer = {
    setTheme: vi.fn(),
    render: vi.fn(),
  };
  return {
    readOnly: false,
    terminal: {
      cols: 100,
      rows: 30,
      viewportY: 0,
      wasmTerm,
      renderer,
      write: vi.fn(),
      focus: vi.fn(),
      reset: vi.fn(),
      paste: vi.fn(),
    },
    write: vi.fn(),
    fit: vi.fn(),
    resize: vi.fn(),
    setReadOnly: vi.fn(),
    attach: vi.fn(),
    dispose,
  };
}

function terminalOpenResult(sessionId: string) {
  return {
    sessionId,
    agentId: "ops",
    shell: "/bin/zsh",
    cwd: "/work/ops",
    confined: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

import { OpenClawTerminalPanel } from "./terminal-panel.ts";

const TERMINAL_PANEL_ELEMENT_NAME = `test-openclaw-terminal-panel-${crypto.randomUUID()}`;

// The full non-isolated UI suite can import the production panel before this
// test. Override its factory instead of relying on a module mock import order.
class TestTerminalPanel extends OpenClawTerminalPanel {
  protected override createTerminal = createGhosttyTerminalMock as unknown as TerminalFactory;
}

customElements.define(TERMINAL_PANEL_ELEMENT_NAME, TestTerminalPanel);

async function startPanelWithPendingOpen() {
  let createOptions: CreateOptions | undefined;
  createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
    createOptions = options;
    return createTerminalController();
  });
  const open = deferred<ReturnType<typeof terminalOpenResult>>();
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
  panel.available = true;
  document.body.append(panel);
  panel.toggle();
  await waitForFast(() =>
    expect(requests.some(({ method }) => method === "terminal.open")).toBe(true),
  );
  return { createOptions: createOptions!, open, requests };
}

describe("OpenClawTerminalPanel", () => {
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

  it("restores persisted open state when a mounted tag upgrades lazily", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "bottom", height: 320, width: 520 }),
    );
    const tagName = `test-lazy-terminal-panel-${crypto.randomUUID()}`;
    const element = document.createElement(tagName) as HTMLElement & { available: boolean };
    element.available = true;
    document.body.append(element);

    class LazyUpgradeTerminalPanel extends TestTerminalPanel {}
    customElements.define(tagName, LazyUpgradeTerminalPanel);
    const panel = element as unknown as OpenClawTerminalPanel;
    await panel.updateComplete;
    await waitForFast(() => expect((panel as unknown as { open: boolean }).open).toBe(true));
  });

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
        return {
          sessionId: "session-1",
          agentId: "ops",
          shell: "/bin/zsh",
          cwd: "/work/ops",
          confined: false,
        } as T;
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
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

  it("answers live OSC default-color queries with the terminal theme", async () => {
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await waitForFast(() => {
      expect(requests.some(({ method }) => method === "terminal.resize")).toBe(true);
    });

    const query = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\";
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
    });
    expect(new TextDecoder().decode(controller.write.mock.calls[0]?.[0])).toBe(query);
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };

    panel.handleToggleRequest(new CustomEvent("openclaw:terminal-toggle", { detail: { catalog } }));

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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.toggle();

    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
    });
    expect(requests.filter((entry) => entry.method === "terminal.list")).toHaveLength(1);
    expect(requests.some((entry) => entry.method === "terminal.attach")).toBe(false);
    expect(requests.some((entry) => entry.method === "terminal.open")).toBe(false);
    expect(controller.terminal.reset).not.toHaveBeenCalled();
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.toggle();

    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited");
    });
    expect(requests.filter((entry) => entry.method === "terminal.attach")).toHaveLength(1);
    expect(requests.filter((entry) => entry.method === "terminal.list")).toHaveLength(2);
    expect(requests.some((entry) => entry.method === "terminal.open")).toBe(false);
    expect(controller.terminal.reset).not.toHaveBeenCalled();
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

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

  it("discovers and attaches detached sessions from a fresh browser profile", async () => {
    const controllers = [
      createTerminalController(),
      createTerminalController(),
      createTerminalController(),
    ] as const;
    createGhosttyTerminalMock
      .mockResolvedValueOnce(controllers[0])
      .mockResolvedValueOnce(controllers[1])
      .mockResolvedValueOnce(controllers[2]);
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          return terminalOpenResult("current-1") as T;
        }
        if (method === "terminal.list") {
          return {
            sessions: [
              {
                ...terminalOpenResult("current-1"),
                attached: true,
                createdAtMs: 1,
              },
              {
                sessionId: "detached-1",
                agentId: "detached-agent",
                shell: "/bin/bash",
                cwd: "/work/detached",
                confined: false,
                attached: false,
                createdAtMs: 2,
              },
              {
                sessionId: "remote-1",
                agentId: "remote-agent",
                shell: "/bin/zsh",
                cwd: "/work/remote",
                confined: false,
                attached: true,
                createdAtMs: 3,
              },
            ],
          } as T;
        }
        if (method === "terminal.attach") {
          return {
            sessionId: "detached-1",
            agentId: "detached-agent",
            shell: "/bin/bash",
            cwd: "/work/detached",
            confined: false,
            buffer: "detached history",
            seq: "detached history".length,
          } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await waitForFast(() => {
      expect(requests.some((request) => request.method === "terminal.open")).toBe(true);
    });

    (
      panel.renderRoot.querySelector('[aria-label="Terminal sessions"]') as HTMLButtonElement
    ).click();
    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tp-session-menu")?.textContent).toContain(
        "detached-agent",
      );
    });
    const menuText = panel.renderRoot.querySelector(".tp-session-menu")?.textContent;
    expect(menuText).toContain("/work/detached");
    expect(menuText).toContain("detached");
    expect(menuText).toContain("attached");
    expect(menuText).toContain("current");

    const detachedRow = [
      ...panel.renderRoot.querySelectorAll<HTMLButtonElement>(".tp-session"),
    ].find((button) => button.textContent?.includes("detached-agent"));
    detachedRow?.click();
    await (
      panel as unknown as { attachPickedSession: (sessionId: string) => Promise<void> }
    ).attachPickedSession("detached-1");

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "detached-1" },
      });
    });
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
    expect(controllers[1].terminal.reset).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(controllers[1].write.mock.calls[0]?.[0])).toBe(
      "detached history",
    );
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["current-1", "detached-1"]),
    );
  });

  it("keeps the newest session picker refresh when requests finish out of order", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    type ListedSession = ReturnType<typeof terminalOpenResult> & {
      attached: boolean;
      createdAtMs: number;
    };
    const firstList = deferred<{ sessions: ListedSession[] }>();
    const secondList = deferred<{ sessions: ListedSession[] }>();
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
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
    const firstBoot = deferred<ReturnType<typeof createTerminalController>>();
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await waitForFast(() => expect(createGhosttyTerminalMock).toHaveBeenCalledOnce());
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };

    panel.handleToggleRequest(new CustomEvent("openclaw:terminal-toggle", { detail: { catalog } }));
    firstBoot.resolve(createTerminalController());

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.open",
        params: { agentId: undefined, cols: 100, rows: 30, catalog },
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
        return {
          sessionId: "session-1",
          agentId: "ops",
          shell: "/bin/zsh",
          cwd: "/work/ops",
          confined: false,
        } as T;
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = oldClient;
    panel.available = true;
    document.body.append(panel);
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
    const staleBoot = deferred<typeof staleController>();
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
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

  it("removes a tab host even when controller disposal throws", () => {
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = vi.fn(() => {
      throw new Error("dispose failed");
    });
    const disposeTab = (
      panel as unknown as {
        disposeTab(tab: { controller: { dispose(): void }; host: HTMLDivElement }): void;
      }
    ).disposeTab.bind(panel);

    expect(() => disposeTab({ controller: { dispose }, host })).not.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(false);
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
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
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
