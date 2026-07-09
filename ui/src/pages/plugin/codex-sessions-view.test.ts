import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getCodexSessionsState, stopCodexSessionsPolling } from "./codex-sessions-controller.ts";
import { renderCodexSessions } from "./codex-sessions-view.ts";

describe("Codex sessions view", () => {
  const hosts: object[] = [];
  const client = { request: async () => ({ hosts: [] }) } as unknown as GatewayBrowserClient;

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      stopCodexSessionsPolling(host);
    }
  });

  it("groups session metadata by host while preserving partial host errors", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.refreshedAtMs = Date.now();
    state.hosts = [
      {
        hostId: "gateway:local",
        label: "Studio Gateway",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: "019f-current-thread",
            name: "Federate Codex sessions",
            cwd: "/Users/example/Projects/sample-app",
            status: "active",
            source: "vscode",
            modelProvider: "openai",
            gitBranch: "codex/session-fleet",
            recencyAt: 1_783_552_800,
            archived: false,
          },
        ],
      },
      {
        hostId: "node:devbox",
        label: "Dev Box",
        kind: "node",
        connected: false,
        sessions: [],
        error: { code: "NODE_OFFLINE", message: "Node is not connected" },
      },
    ];
    const container = document.createElement("div");

    render(renderCodexSessions({ host, client, connected: true }), container);

    expect(container.querySelectorAll(".codex-host")).toHaveLength(2);
    expect(
      container.querySelector("[data-thread-id='019f-current-thread']")?.textContent,
    ).toContain("Federate Codex sessions");
    expect(container.textContent).toContain("/Users/example/Projects/sample-app");
    expect(container.textContent).toContain("Dev Box");
    expect(container.textContent).toContain("Node is not connected");
    expect(container.querySelector(".codex-sessions__partial")?.textContent).toContain(
      "Unavailable hosts: 1",
    );
  });

  it("keeps transcript-derived preview text out of the session rows", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.refreshedAtMs = Date.now();
    state.hosts = [
      {
        hostId: "gateway:local",
        label: "Gateway",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: "thread-1",
            name: null,
            status: "notLoaded",
            archived: false,
          },
        ],
      },
    ];
    const container = document.createElement("div");

    render(renderCodexSessions({ host, client, connected: true }), container);

    expect(container.querySelector(".codex-session__title")?.textContent).toBe(
      "Untitled Codex session",
    );
    expect(container.querySelector(".codex-session__preview")).toBeNull();
  });

  it("renders a Codex system error as a localized error status", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.refreshedAtMs = Date.now();
    state.hosts = [
      {
        hostId: "gateway:local",
        label: "Gateway",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: "thread-error",
            name: "Broken thread",
            status: "systemError",
            archived: false,
          },
        ],
      },
    ];
    const container = document.createElement("div");

    render(renderCodexSessions({ host, client, connected: true }), container);

    const status = container.querySelector(".codex-session__status");
    expect(status?.textContent).toContain("System error");
    expect(status?.classList.contains("codex-session__status--error")).toBe(true);
  });

  it("disables every request control while the Gateway is offline", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.refreshedAtMs = Date.now();
    state.hosts = [
      {
        hostId: "node:macbook",
        label: "MacBook",
        kind: "node",
        connected: true,
        sessions: [],
        nextCursor: "next-page",
      },
    ];
    const container = document.createElement("div");

    render(renderCodexSessions({ host, client, connected: false }), container);

    expect((container.querySelector("input[type='search']") as HTMLInputElement).disabled).toBe(
      true,
    );
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
    expect(container.textContent).not.toContain("MacBook");
    expect(state.hosts).toEqual([]);
    expect(container.querySelector(".codex-sessions__refresh")?.getAttribute("aria-label")).toBe(
      "Refresh",
    );
  });
});
