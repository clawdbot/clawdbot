/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";
import type { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";

function createTerminalController() {
  return {
    readOnly: false,
    terminal: {
      cols: 100,
      rows: 30,
      viewportY: 0,
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
    dispose: vi.fn(),
  };
}

const createTerminal = vi.fn(async () => createTerminalController());

class ReadinessTestTerminalPanel extends OpenClawTerminalPanel {
  protected override createTerminal =
    createTerminal as unknown as typeof createIsolatedGhosttyTerminal;
}

const TERMINAL_PANEL_ELEMENT_NAME = `test-terminal-panel-readiness-${crypto.randomUUID()}`;
customElements.define(TERMINAL_PANEL_ELEMENT_NAME, ReadinessTestTerminalPanel);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function terminalOpenResult(sessionId: string) {
  return {
    sessionId,
    agentId: "main",
    shell: "/bin/zsh",
    cwd: "/work",
    confined: false,
  };
}

describe("terminal panel readiness", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    createTerminal.mockClear();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("keeps an already closed panel closed for an explicit close request", () => {
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.available = true;
    document.body.append(panel);

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", { detail: { open: false } }),
    );

    expect((panel as unknown as { open: boolean }).open).toBe(false);
  });

  it("opens and co-attaches an agent terminal requested by ui.command", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("agent-terminal-1"),
            buffer: "ready",
            seq: 5,
          } as T;
        }
        return { ok: true } as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "agent-terminal-1" },
      }),
    );

    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "agent-terminal-1" },
      });
      expect(panel.renderRoot.querySelector(".tabstrip-tab__badge")?.textContent).toBe("agent");
    });
  });

  it("shows a connecting animation while a terminal open is in flight", async () => {
    const open = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
    }>();
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: <T>(method: string) =>
        (method === "terminal.open" ? open.promise : Promise.resolve({})) as Promise<T>,
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();

    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector(".tp-connecting")?.textContent).toContain(
        "Connecting to session",
      );
      expect(
        panel.renderRoot.querySelector(".tabstrip-tab")?.classList.contains("is-connecting"),
      ).toBe(true);
    });

    open.resolve(terminalOpenResult("session-1"));
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector(".tp-connecting")).toBeNull();
      expect(panel.renderRoot.querySelector(".tabstrip-tab")?.classList.contains("is-live")).toBe(
        true,
      );
    });
  });

  it("persists a catalog tab after its first output arrives", async () => {
    const controller = createTerminalController();
    createTerminal.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return {
          ...terminalOpenResult("catalog-terminal-1"),
          title: "codex resume 0d5c…",
        } as T;
      },
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
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };

    panel.handleToggleRequest(new CustomEvent("openclaw:terminal-toggle", { detail: { catalog } }));

    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: "terminal.open",
        params: { agentId: undefined, cols: 100, rows: 30, catalog },
      });
    });
    expect(panel.renderRoot.querySelector(".tabstrip-tab")?.textContent).toContain(
      "codex resume 0d5c…",
    );
    expect(panel.renderRoot.querySelector(".tp-connecting")?.textContent).toContain(
      "Connecting to session",
    );

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "catalog-terminal-1", seq: 5, data: "ready" },
    });
    await vi.waitFor(() => expect(panel.renderRoot.querySelector(".tp-connecting")).toBeNull());
    expect(new TextDecoder().decode(controller.write.mock.calls[0]?.[0])).toBe("ready");
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["catalog-terminal-1"]),
    );
  });

  it("marks a catalog terminal ready when its first visible output is a replay", async () => {
    const controller = createTerminalController();
    createTerminal.mockResolvedValue(controller);
    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("catalog-terminal-1"),
            buffer: "recovered output",
            seq: 12,
          } as T;
        }
        return {
          ...terminalOpenResult("catalog-terminal-1"),
          title: "claude --resume 1234…",
        } as T;
      },
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

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { catalog: { catalogId: "anthropic", hostId: "node:mac", threadId: "thread" } },
      }),
    );
    await vi.waitFor(() => expect(panel.renderRoot.querySelector(".tp-connecting")).not.toBeNull());

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "catalog-terminal-1", seq: 12, data: "gap" },
    });

    await vi.waitFor(() => expect(panel.renderRoot.querySelector(".tp-connecting")).toBeNull());
    expect(requests).toContainEqual({
      method: "terminal.attach",
      params: { sessionId: "catalog-terminal-1" },
    });
    expect(controller.terminal.reset).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(controller.write.mock.calls[0]?.[0])).toBe("recovered output");
  });

  it("closes a catalog terminal and shows an error when no output arrives", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return (
          method === "terminal.open"
            ? { ...terminalOpenResult("catalog-terminal-1"), title: "claude --resume 1234…" }
            : {}
        ) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    (panel as unknown as { catalogReadyTimeoutMs: number }).catalogReadyTimeoutMs = 5;
    document.body.append(panel);

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { catalog: { catalogId: "anthropic", hostId: "node:mac", threadId: "thread" } },
      }),
    );

    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector(".tp-error")?.textContent).toContain(
        "Session did not connect within 30 seconds",
      );
    });
    expect(requests).toContainEqual({
      method: "terminal.close",
      params: { sessionId: "catalog-terminal-1" },
    });
    expect(panel.renderRoot.querySelector(".tabstrip-tab")).toBeNull();
  });
});
