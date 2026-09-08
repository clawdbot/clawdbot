/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshControlUiServiceWorker } from "../../app/sw-refresh.runtime.ts";
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

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);

describe("OpenClawTerminalPanel reconnect", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    createGhosttyTerminalMock.mockReset();
    vi.mocked(refreshControlUiServiceWorker).mockReset();
    vi.mocked(refreshControlUiServiceWorker).mockResolvedValue(false);
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it.each(["conn", "agent:agent:main:background-task"] as const)(
    "attaches a %s session with its native title and actual owner",
    async (owner) => {
      const controllers = [createTerminalController(), createTerminalController()] as const;
      createGhosttyTerminalMock
        .mockResolvedValueOnce(controllers[0])
        .mockResolvedValueOnce(controllers[1]);
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
                { ...terminalOpenResult("current-1"), attached: true, createdAtMs: 1 },
                {
                  sessionId: "detached-1",
                  agentId: "detached-agent",
                  shell: "/bin/bash",
                  cwd: "/work/detached",
                  confined: false,
                  attached: false,
                  owner,
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
              title: "codex",
              owner,
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
      expect(
        [...panel.renderRoot.querySelectorAll<HTMLElement>(".tp-session")]
          .find((row) => row.textContent?.includes("detached-agent"))
          ?.querySelector(".tp-session__state")?.textContent,
      ).toContain(owner === "conn" ? "detached" : "agent");
      expect(menuText).toContain("attached");
      expect(menuText).toContain("current");
      const detachedRow = [
        ...panel.renderRoot.querySelectorAll<HTMLButtonElement>(".tp-session"),
      ].find((button) => button.textContent?.includes("detached-agent"));
      detachedRow?.click();

      await waitForFast(() => {
        expect(requests).toContainEqual({
          method: "terminal.attach",
          params: { sessionId: "detached-1" },
        });
        expect(controllers[1].terminal.focus).toHaveBeenCalled();
      });
      expect(new TextDecoder().decode(controllers[1].write.mock.calls[0]?.[0])).toBe(
        "detached history",
      );
      expect(panel.renderRoot.querySelector(".tabstrip-tab__badge")?.textContent).toBe(
        owner === "conn" ? undefined : "agent",
      );
      expect(panel.renderRoot.textContent).toContain("codex");
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
        JSON.stringify(["current-1", "detached-1"]),
      );
    },
  );

  it("reattaches a same-client reconnect and replaces gapped terminal state", async () => {
    const controllers = [
      createTerminalController(),
      createTerminalController(),
      createTerminalController(),
    ] as const;
    const controllerParents: HTMLElement[] = [];
    createGhosttyTerminalMock.mockImplementation(async (options) => {
      const currentIndex = createGhosttyTerminalMock.mock.calls.length - 1;
      const controller = controllers[currentIndex];
      if (!controller) {
        throw new Error("unexpected terminal controller creation");
      }
      controllerParents[currentIndex] = options.parent;
      return controller;
    });

    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const replay = "reconnected shell\r\n$ ";
    const recoveredReplay = `${replay}?gap`;
    const attachReplays = [replay, recoveredReplay] as const;
    let attachCount = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          return terminalOpenResult("surviving-session") as T;
        }
        if (method === "terminal.list") {
          return {
            sessions: [
              { ...terminalOpenResult("surviving-session"), attached: false, createdAtMs: 1 },
            ],
          } as T;
        }
        if (method === "terminal.attach") {
          const buffer = attachReplays[attachCount++];
          if (!buffer) {
            throw new Error("unexpected terminal attach");
          }
          return {
            ...terminalOpenResult("surviving-session"),
            buffer,
            seq: buffer.length,
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
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toContain(
        "surviving-session",
      );
    });

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    await waitForFast(() => expect(controllers[0].dispose).toHaveBeenCalledOnce());

    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(0);
    releaseRefresh?.(false);
    await waitForFast(() => {
      expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
    });

    expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
    expect(controllers[0].dispose).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(controllers[1].write.mock.calls[0]?.[0])).toBe(replay);

    const previousHost = controllerParents[1];
    if (!previousHost) {
      throw new Error("missing reconnected terminal host");
    }
    previousHost.style.display = "none";
    previousHost.style.visibility = "collapse";

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "surviving-session", seq: replay.length + 4, data: "gap" },
    });
    await waitForFast(() => expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(3));
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);

    await waitForFast(() => expect(controllers[1].dispose).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(controllers[2].write.mock.calls[0]?.[0])).toBe(recoveredReplay);
    expect(controllers[2].setReadOnly).toHaveBeenCalledWith(false);
    expect(controllerParents[2]?.style.display).toBe("none");
    expect(controllerParents[2]?.style.visibility).toBe("collapse");
    expect(controllerParents[2]?.inert).toBe(false);

    listener?.({
      event: "terminal.data",
      payload: { sessionId: "surviving-session", seq: recoveredReplay.length + 1, data: "!" },
    });
    await waitForFast(() => expect(controllers[2].write).toHaveBeenCalledTimes(2));
    expect(new TextDecoder().decode(controllers[2].write.mock.calls[1]?.[0])).toBe("!");
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);
    expect(controllers[1].dispose).toHaveBeenCalledOnce();
  });

  it("replays and deduplicates explicit terminal actions after a same-client reconnect fence", async () => {
    createGhosttyTerminalMock
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController())
      .mockResolvedValueOnce(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    let opened = 0;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          const sessionId = (params as { sessionId: string }).sessionId;
          const buffer = `${sessionId} ready`;
          return {
            ...terminalOpenResult(sessionId),
            buffer,
            seq: buffer.length,
          } as T;
        }
        if (method === "terminal.open") {
          opened += 1;
          return terminalOpenResult(`opened-terminal-${opened}`) as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.agentId = "research";
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.available = false;
    await panel.updateComplete;

    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());

    const catalog = { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" };
    const requested = new CustomEvent("openclaw:terminal-toggle", {
      detail: { open: true, terminalSessionId: "requested-terminal" },
    });
    panel.handleToggleRequest(requested);
    panel.handleToggleRequest(requested);
    const sessions = (
      panel as unknown as {
        terminalSessions: {
          attachSessionById(sessionId: string, agentOwned?: boolean): Promise<void>;
        };
      }
    ).terminalSessions;
    void sessions.attachSessionById("picked-terminal");
    void sessions.attachSessionById("picked-terminal");
    await panel.updateComplete;
    const newSession = panel.renderRoot.querySelector<HTMLButtonElement>(
      '[aria-label="New terminal session"]',
    );
    expect(newSession?.disabled).toBe(false);
    newSession?.click();
    newSession?.click();
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", { detail: { open: true, catalog } }),
    );
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", { detail: { open: true, catalog } }),
    );
    panel.agentId = "main";

    expect(requests).toHaveLength(0);
    await waitForFast(() => {
      expect(
        panel.renderRoot
          .querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="terminal"]')
          ?.getAttribute("aria-label"),
      ).toContain("Connecting to session");
    });

    releaseRefresh?.(false);
    await waitForFast(() => {
      expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);
      expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(2);
    });
    expect(
      requests.filter(
        (request) => request.method === "terminal.attach" || request.method === "terminal.open",
      ),
    ).toEqual([
      { method: "terminal.attach", params: { sessionId: "requested-terminal" } },
      { method: "terminal.attach", params: { sessionId: "picked-terminal" } },
      {
        method: "terminal.open",
        params: { agentId: "research", cols: 100, rows: 30 },
      },
      {
        method: "terminal.open",
        params: { agentId: "research", cols: 100, rows: 30, catalog },
      },
    ]);
    expect(panel.renderRoot.querySelectorAll(".tabstrip-tab__badge")).toHaveLength(1);
  });

  it("cancels captured restore and explicit actions when the panel closes during the fence", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return terminalOpenResult("initial-terminal") as T;
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

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    requests.splice(0);

    let releaseRefresh: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "cancelled-terminal" },
      }),
    );
    panel.closeTerminalPanel();
    releaseRefresh?.(false);
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(panel.terminalPanelOpen).toBe(false);
    expect(requests).toHaveLength(0);
    expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
  });

  it("retires an older refresh generation without losing its queued action", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("generation-terminal"),
            buffer: "ready",
            seq: 5,
          } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const releases: Array<(replacementActivated: boolean) => void> = [];
    vi.mocked(refreshControlUiServiceWorker).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releases.push(resolve);
        }),
    );
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "generation-terminal" },
      }),
    );

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[0]?.(false);
    await Promise.resolve();
    expect(requests).toHaveLength(0);
    releases[1]?.(false);
    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "generation-terminal" },
      });
    });
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
  });

  it("shows reload guidance when a fenced action cannot make progress", async () => {
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>() => ({}) as T,
      addEventListener: () => () => {},
    };
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(new Promise<boolean>(() => {}));
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.catalogReadyTimeoutMs = 10;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.client = null;
    panel.available = false;
    await panel.updateComplete;
    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "stalled-terminal" },
      }),
    );

    await waitForFast(() => {
      expect(panel.renderRoot.querySelector(".tp-error")?.textContent).toContain(
        "Reload this page to continue the terminal action",
      );
    });
    expect(
      panel.renderRoot.querySelector(
        'openclaw-panel-loading-skeleton[data-panel-skeleton="terminal"]',
      ),
    ).toBeNull();
  });

  it("carries an explicit terminal action through an activated-worker reload", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.attach") {
          return {
            ...terminalOpenResult("requested-after-reload"),
            buffer: "reloaded terminal ready",
            seq: 23,
          } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const stalePanel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    stalePanel.client = client;
    stalePanel.available = true;
    document.body.append(stalePanel);

    stalePanel.client = null;
    stalePanel.available = false;
    await stalePanel.updateComplete;

    let activateReplacement: ((replacementActivated: boolean) => void) | undefined;
    vi.mocked(refreshControlUiServiceWorker).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        activateReplacement = resolve;
      }),
    );
    stalePanel.client = client;
    stalePanel.available = true;
    await stalePanel.updateComplete;
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    stalePanel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", {
        detail: { open: true, terminalSessionId: "requested-after-reload" },
      }),
    );
    activateReplacement?.(true);
    await Promise.resolve();
    expect(requests).toHaveLength(0);

    stalePanel.remove();
    const currentPanel = document.createElement(
      TERMINAL_PANEL_ELEMENT_NAME,
    ) as OpenClawTerminalPanel;
    currentPanel.client = client;
    currentPanel.available = true;
    document.body.append(currentPanel);

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "requested-after-reload" },
      });
    });
    expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(1);
  });
});
