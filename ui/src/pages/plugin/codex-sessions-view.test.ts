import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    vi.restoreAllMocks();
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
    expect(
      (container.querySelector(".codex-session__continue") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((container.querySelector(".codex-session__archive") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("continues an idle row as a branch through the supplied navigation callback", async () => {
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
            threadId: "thread-idle",
            name: "Finish the release",
            status: "idle",
            archived: false,
          },
        ],
      },
    ];
    const request = vi.fn(async () => ({
      sessionKey: "agent:main:codex-release",
      disposition: "forked",
    }));
    const actionClient = { request } as unknown as GatewayBrowserClient;
    const onContinueSession = vi.fn();
    const container = document.createElement("div");

    render(
      renderCodexSessions({
        host,
        client: actionClient,
        connected: true,
        onContinueSession,
      }),
      container,
    );
    const continueButton = container.querySelector(".codex-session__continue") as HTMLButtonElement;
    expect(continueButton.getAttribute("aria-label")).toBe(
      "Continue Finish the release as a branch",
    );
    expect(continueButton.textContent).toContain("Continue as branch");
    continueButton.click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("codex.sessions.continue", {
        hostId: "gateway:local",
        threadId: "thread-idle",
      }),
    );
    await vi.waitFor(() =>
      expect(onContinueSession).toHaveBeenCalledWith("agent:main:codex-release"),
    );
  });

  it("revalidates an already adopted active session through Continue before opening it", async () => {
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
            threadId: "thread-adopted",
            name: "Already supervised",
            status: "active",
            openClawSessionKey: " agent:main:adopted-codex ",
            archived: false,
          },
        ],
      },
    ];
    const request = vi.fn(async () => ({
      sessionKey: "agent:main:current-adopted-codex",
      disposition: "existing",
    }));
    const onContinueSession = vi.fn();
    const container = document.createElement("div");

    render(
      renderCodexSessions({
        host,
        client: { request } as unknown as GatewayBrowserClient,
        connected: true,
        onContinueSession,
      }),
      container,
    );
    const openButton = container.querySelector(".codex-session__continue") as HTMLButtonElement;
    expect(openButton.disabled).toBe(false);
    expect(openButton.getAttribute("aria-label")).toBe("Open Chat for Already supervised");
    expect(openButton.textContent).toContain("Open Chat");
    openButton.click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("codex.sessions.continue", {
        hostId: "gateway:local",
        threadId: "thread-adopted",
      }),
    );
    await vi.waitFor(() =>
      expect(onContinueSession).toHaveBeenCalledWith("agent:main:current-adopted-codex"),
    );
  });

  it("requires an explicit no-other-runner confirmation before archiving", async () => {
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
            threadId: "thread-archive",
            name: "Finished work",
            status: "idle",
            archived: false,
          },
        ],
      },
    ];
    const request = vi.fn(async () => ({ archived: true }));
    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const container = document.createElement("div");

    render(
      renderCodexSessions({
        host,
        client: { request } as unknown as GatewayBrowserClient,
        connected: true,
      }),
      container,
    );
    (container.querySelector(".codex-session__archive") as HTMLButtonElement).click();

    expect(confirm).toHaveBeenCalledWith(
      "Archive Finished work and any spawned descendants? Confirm that no other Codex client or OpenClaw runner is using them. Archiving while another runner is active may interrupt its work.",
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("codex.sessions.archive", {
        hostId: "gateway:local",
        threadId: "thread-archive",
        confirmNoOtherRunner: true,
      }),
    );
  });

  it("keeps actions disabled for sessions on an offline host", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.refreshedAtMs = Date.now();
    state.hosts = [
      {
        hostId: "node:offline",
        label: "Offline Mac",
        kind: "node",
        connected: false,
        sessions: [
          {
            threadId: "thread-offline",
            name: "Stored elsewhere",
            status: "notLoaded",
            archived: false,
          },
        ],
      },
    ];
    const container = document.createElement("div");

    render(renderCodexSessions({ host, client, connected: true }), container);

    expect(
      (container.querySelector(".codex-session__continue") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((container.querySelector(".codex-session__archive") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(container.querySelector(".codex-session__continue")?.getAttribute("title")).toBe(
      "Reconnect this computer before managing its Codex sessions.",
    );
    expect(container.querySelector(".codex-session__view-only")?.textContent).toContain(
      "Transcript available; continue and archive stay on the owning computer.",
    );
  });

  it("explains that connected paired-computer sessions allow transcript reads only", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.refreshedAtMs = Date.now();
    state.hosts = [
      {
        hostId: "node:remote",
        label: "Remote Mac",
        kind: "node",
        connected: true,
        nextCursor: "next-page",
        sessions: [
          {
            threadId: "thread-remote",
            name: "Stored remotely",
            status: "notLoaded",
            archived: false,
          },
        ],
      },
    ];
    const container = document.createElement("div");

    render(renderCodexSessions({ host, client, connected: true }), container);

    const continueButton = container.querySelector(".codex-session__continue") as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    expect(continueButton.title).toBe(
      "Transcript available; continue and archive stay on the owning computer.",
    );
    expect(container.querySelector(".codex-session__view-only")?.textContent).toContain(
      "Transcript available; continue and archive stay on the owning computer.",
    );
    expect((container.querySelector(".codex-session__archive") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(container.querySelector(".codex-host__footer button")?.getAttribute("aria-label")).toBe(
      "Load more — Remote Mac",
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
    expect(container.querySelector(".codex-sessions__scope")).toBeNull();
    expect(container.textContent).not.toContain("read-only");
    expect(container.textContent).toContain("Stored / activity unknown");
    const continueButton = container.querySelector(".codex-session__continue") as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
    expect(continueButton.textContent).toContain("Continue as branch");
    expect(continueButton.title).toBe(
      "Create a Chat from persisted visible history. On your first message, Codex App Server selects the model and provider for the new harness thread. Later selection remains Codex-controlled; OpenClaw never substitutes another runtime, model, or fallback. The source remains untouched, and in-flight work may be absent.",
    );
    const archiveButton = container.querySelector(".codex-session__archive") as HTMLButtonElement;
    expect(archiveButton.disabled).toBe(false);
    expect(archiveButton.title).toBe(
      "Activity is unknown because status is process-local. Archive only after confirming that no other Codex client or runner is using this session.",
    );
  });

  it("renders readable transcript text and preserves the full persisted item", () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = [
      {
        hostId: "node:macbook",
        label: "MacBook",
        kind: "node",
        connected: true,
        sessions: [
          {
            threadId: "thread-1",
            name: "Inspect the screenshot",
            status: "idle",
            archived: false,
          },
        ],
      },
    ];
    state.transcriptKey = JSON.stringify(["node:macbook", "thread-1"]);
    state.transcriptItems = [
      {
        id: "item-1",
        type: "userMessage",
        content: [
          { type: "text", text: "Read the complete prompt" },
          { type: "image", url: "attachment://screenshot.png" },
        ],
      },
    ];
    const container = document.createElement("div");

    render(
      renderCodexSessions({
        host,
        client,
        connected: true,
        selectedHostId: "node:macbook",
        selectedThreadId: "thread-1",
      }),
      container,
    );

    expect(container.querySelector(".codex-transcript__text")?.textContent).toContain(
      "Read the complete prompt",
    );
    expect(container.querySelector(".codex-transcript__details pre")?.textContent).toContain(
      "attachment://screenshot.png",
    );
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
    expect(
      (container.querySelector(".codex-session__continue") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((container.querySelector(".codex-session__archive") as HTMLButtonElement).disabled).toBe(
      true,
    );
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
