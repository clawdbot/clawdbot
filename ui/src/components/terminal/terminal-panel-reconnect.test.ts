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

describe("OpenClawTerminalPanel reconnect", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("attaches a detached session from a fresh browser profile", async () => {
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

    await waitForFast(() => {
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "detached-1" },
      });
    });
    expect(new TextDecoder().decode(controllers[1].write.mock.calls[0]?.[0])).toBe(
      "detached history",
    );
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe(
      JSON.stringify(["current-1", "detached-1"]),
    );
  });

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

    panel.client = client;
    panel.available = true;
    await panel.updateComplete;
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
});
