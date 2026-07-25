/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
  TaskSuggestion,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import { cacheChatSessionSnapshot, type ChatMessageCache } from "./session-message-cache.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:current",
  agentId: "main",
  createdAt: 1,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function dispatchSidebarShortcut(pane: TestChatPane, shiftKey = true) {
  const event = new KeyboardEvent("keydown", {
    cancelable: true,
    key: "b",
    metaKey: true,
    shiftKey,
  });
  pane.handleDocumentKeydown(event);
  return event;
}

function createInitializationContext(): ApplicationContext {
  return {
    basePath: "",
    gateway: { snapshot: { hello: null } },
    config: {
      current: {
        assistantIdentity: {
          agentId: null,
          name: "Assistant",
          avatar: null,
          avatarSource: null,
          avatarStatus: null,
          avatarReason: null,
        },
        serverVersion: null,
        localMediaPreviewRoots: [],
        embedSandboxMode: "strict",
        allowExternalEmbedUrls: false,
        terminalEnabled: false,
      },
    },
    agentSelection: { state: { selectedId: "main" } },
    agents: { state: { agentsList: null } },
    initialUserMessage: createInitialUserMessageHandoff(),
    sessions: {},
  } as unknown as ApplicationContext;
}

function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}

describe("chat pane pull request refresh", () => {
  it("forwards an explicit refresh and publishes live PR state", async () => {
    const request = vi.fn().mockResolvedValue({
      pullRequests: [
        {
          number: 111532,
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/pr-detection",
          title: "Detect pull requests",
          url: "https://github.com/openclaw/openclaw/pull/111532",
          state: "open",
        },
      ],
      rateLimited: false,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const sessions = {
      capturePullRequestEpoch: vi.fn(() => epoch),
      setPullRequestSummary,
    } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests({ refresh: true });

    expect(request).toHaveBeenCalledWith(
      "controlUi.sessionPullRequests",
      expect.objectContaining({ sessionKey: "agent:main:current", refresh: true }),
    );
    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      { numbers: [111532], state: "open" },
      epoch,
    );
  });

  it("clears the pane snapshot when the Gateway source disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const { pane } = createTestChatPane({
      client,
      sessions: {
        capturePullRequestEpoch: vi.fn(() => Symbol("pr-refresh")),
        setPullRequestSummary: vi.fn(),
      } as unknown as SessionCapability,
    });
    pane.sessionPullRequests = [
      {
        number: 111532,
        owner: "openclaw",
        repo: "openclaw",
        branch: "claude/pr-detection",
        title: "Detect pull requests",
        url: "https://github.com/openclaw/openclaw/pull/111532",
        state: "open",
      },
    ];

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting" as const,
    });

    expect(pane.sessionPullRequests).toEqual([]);
  });

  it("preserves shared PR state for an empty rate-limited snapshot", async () => {
    const request = vi.fn().mockResolvedValue({ pullRequests: [], rateLimited: true });
    const setPullRequestSummary = vi.fn();
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        capturePullRequestEpoch: vi.fn(() => Symbol("pr-refresh")),
        setPullRequestSummary,
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).not.toHaveBeenCalled();
  });

  it("clears shared live PR state after the PR settles", async () => {
    const request = vi.fn().mockResolvedValue({
      pullRequests: [
        {
          number: 111532,
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/pr-detection",
          title: "Detect pull requests",
          url: "https://github.com/openclaw/openclaw/pull/111532",
          state: "merged",
        },
      ],
      rateLimited: false,
    });
    const epoch = Symbol("pr-refresh");
    const setPullRequestSummary = vi.fn();
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {
        capturePullRequestEpoch: vi.fn(() => epoch),
        setPullRequestSummary,
      } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["controlUi.sessionPullRequests"] },
    } as never;

    await pane.refreshSessionPullRequests();

    expect(setPullRequestSummary).toHaveBeenCalledWith(
      "agent:main:current",
      { numbers: [111532], state: "merged" },
      epoch,
    );
  });
});

describe("chat pane header state", () => {
  it("commits a trimmed label and clears with null", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.beginHeaderRename(session);
    pane.headerRenameValue = "  Renamed session  ";
    pane.commitHeaderRename();
    expect(patch).toHaveBeenCalledWith(
      session.key,
      { label: "Renamed session" },
      { agentId: "main" },
    );

    const labeled = { ...session, label: "Renamed session" };
    pane.beginHeaderRename(labeled);
    pane.headerRenameValue = "   ";
    pane.commitHeaderRename();
    expect(patch).toHaveBeenLastCalledWith(session.key, { label: null }, { agentId: "main" });
  });

  it("cancels and skips unchanged labels", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
    pane.paneTitle = "Derived title";
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.beginHeaderRename(session);
    pane.commitHeaderRename();
    pane.beginHeaderRename(session);
    pane.cancelHeaderRename();
    expect(patch).not.toHaveBeenCalled();
  });

  it("copies the resolved workspace path and branch", async () => {
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const copy = vi.fn(async () => true);
    pane.handleHeaderMenuAction("copy-path", session, "/src/openclaw", "feature/header", copy);
    pane.handleHeaderMenuAction("copy-branch", session, "/src/openclaw", "feature/header", copy);
    await Promise.resolve();
    expect(copy).toHaveBeenNthCalledWith(1, "/src/openclaw");
    expect(copy).toHaveBeenNthCalledWith(2, "feature/header");
  });

  it("does not query gateway-local branches for exec-node sessions", async () => {
    const request = vi.fn();
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    await pane.loadHeaderMenuData(
      {
        key: "agent:main:remote",
        kind: "direct",
        updatedAt: 0,
        execNode: "build-mac",
        execCwd: "/remote/repo",
      },
      "/local/default",
      true,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("retries failed worktree metadata lookups on the next menu open", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        worktrees: [{ id: "wt-1", path: "/src/worktree" }],
      });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const session = {
      key: "agent:main:worktree",
      kind: "direct",
      updatedAt: 0,
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/src/openclaw" },
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(session, "/src/default", true);
    await pane.loadHeaderMenuData(session, "/src/default", true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries failed branch metadata lookups on the next menu open", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ headBranch: "feature/header" });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const session = {
      key: "agent:main:plain",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(session, "/src/openclaw", true);
    await pane.loadHeaderMenuData(session, "/src/openclaw", true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("probes session-specific roots for a branch even when the agent workspace is not Git", async () => {
    const request = vi.fn().mockResolvedValue({ headBranch: "spawned/topic" });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const session = {
      key: "agent:main:spawned",
      kind: "direct",
      updatedAt: 0,
      spawnedWorkspaceDir: "/src/spawned-repo",
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(session, "/plain/agent-workspace", false);
    expect(request).toHaveBeenCalledWith("worktrees.branches", { repoRoot: "/src/spawned-repo" });

    // The agent-workspace root keeps honoring the agent's workspaceGit flag.
    request.mockClear();
    const plain = {
      key: "agent:main:plain2",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(plain, "/plain/agent-workspace", false);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not reuse worktree workspace facts after an in-place session reset", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "worktrees.list") {
        return { worktrees: [{ id: "wt-1", path: "/src/worktree-checkout" }] };
      }
      return { headBranch: "main" };
    });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const worktreeRow = {
      key: "agent:main:reused",
      kind: "direct",
      updatedAt: 0,
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/src/openclaw" },
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(worktreeRow, "/src/agent-workspace", true);

    // New Chat resets the same key in place and detaches the worktree; the
    // branch probe must target the agent workspace, not the stale checkout.
    const resetRow = {
      key: "agent:main:reused",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(resetRow, "/src/agent-workspace", true);
    expect(request).toHaveBeenLastCalledWith("worktrees.branches", {
      repoRoot: "/src/agent-workspace",
    });
  });

  it("skips branch lookups while the session runs remotely", async () => {
    const request = vi.fn().mockResolvedValue({ headBranch: "main" });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const dispatched = {
      key: "agent:main:moves",
      kind: "direct",
      updatedAt: 0,
      placement: { state: "active" } as GatewaySessionRow["placement"],
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(dispatched, "/src/openclaw", true);
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes the head branch on every menu open so checkouts do not go stale", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ headBranch: "main" })
      .mockResolvedValueOnce({ headBranch: "feature/next" });
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const session = {
      key: "agent:main:plain",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    await pane.loadHeaderMenuData(session, "/src/openclaw", true);
    await pane.loadHeaderMenuData(session, "/src/openclaw", true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces resolved reveal failures in the chat error", async () => {
    const request = vi.fn(async () => ({ ok: false, error: "No desktop available." }));
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.handleHeaderMenuAction("reveal", session, "/src/openclaw", null);
    await vi.waitFor(() => expect(state.chatError).toBe("No desktop available."));
  });
});

describe("chat pane initialization", () => {
  it("sets the pane route before attaching outbox projection", () => {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    const targetSessionKey = "agent:main:pane-b";
    const sharedMessages = new Map();
    pane.sessionKey = targetSessionKey;
    pane.chatMessagesBySession = sharedMessages;
    pane.context = createInitializationContext();
    const stopAfterAttach = new Error("stop after attach");
    let attachedSessionKey: string | undefined;
    let attachedMessages: ChatMessageCache | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedSessionKey = state.sessionKey;
      attachedMessages = state.chatMessagesBySession;
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(attachedSessionKey).toBe(targetSessionKey);
      expect(attachedMessages).toBe(sharedMessages);
    } finally {
      pane.disconnectedCallback();
    }
  });

  it("hydrates a new split pane from the shared session snapshot before startup", () => {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    const targetSessionKey = "agent:main:pane-b";
    const messages = [nativeHistoryMessage(1, "retained split history")];
    const sharedMessages: ChatMessageCache = new Map();
    pane.sessionKey = targetSessionKey;
    pane.chatMessagesBySession = sharedMessages;
    pane.context = createInitializationContext();
    cacheChatSessionSnapshot(
      sharedMessages,
      { assistantAgentId: "main", agentsList: null, hello: null },
      { sessionKey: targetSessionKey },
      {
        messages,
        pagination: { hasMore: true, nextOffset: 1, totalMessages: 2 },
        sessionId: "split-session",
      },
    );
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(attachedState?.chatMessages).toEqual(messages);
      expect(attachedState?.chatHistoryPagination).toEqual({
        hasMore: true,
        nextOffset: 1,
        totalMessages: 2,
      });
      expect(attachedState?.currentSessionId).toBe("split-session");
    } finally {
      pane.disconnectedCallback();
    }
  });

  it("starts the connected client when a route alias is already selected canonically", () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane, state } = createTestChatPane({ client, sessions });
    const canonicalSessionKey = "agent:main:main";
    const hello = {
      features: { methods: ["chat.startup"] },
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: canonicalSessionKey,
        },
      },
    } as unknown as NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]>;
    const snapshot = {
      ...pane.context.gateway.snapshot,
      client,
      phase: "connected" as const,
      hello,
      sessionKey: canonicalSessionKey,
    };
    const navigate = vi.fn();
    pane.context = {
      ...pane.context,
      gateway: { ...pane.context.gateway, snapshot },
      config: {
        current: {
          assistantIdentity: {
            agentId: "main",
            avatar: null,
            avatarReason: null,
            avatarSource: null,
            avatarStatus: null,
            name: "Assistant",
          },
          terminalEnabled: false,
        },
      },
    } as unknown as ApplicationContext;
    pane.sessionKey = "main";
    state.sessionKey = canonicalSessionKey;
    state.hello = hello;
    state.loadAssistantIdentity = vi.fn(async () => {});
    pane.connectedClient = null;
    pane.onPaneSessionChange = navigate;

    pane.applyGatewaySnapshot(snapshot);

    expect(navigate).toHaveBeenCalledWith("single", canonicalSessionKey, { replace: true });
    expect(pane.connectedClient).toBe(client);
    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      expect.objectContaining({ sessionKey: canonicalSessionKey }),
    );
  });
});

describe("chat pane keyboard shortcuts", () => {
  it("toggles only the active pane's session workspace", () => {
    const client = {} as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane, state } = createTestChatPane({ client, sessions });
    const canvasContent: SidebarContent = {
      kind: "canvas",
      docId: "canvas-1",
      entryUrl: "/__openclaw__/canvas/canvas-1/index.html",
    };
    pane.active = true;
    state.connected = false;
    state.sidebarContent = canvasContent;
    state.sidebarOpen = true;

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);

    const expandEvent = dispatchSidebarShortcut(pane);

    expect(expandEvent.defaultPrevented).toBe(true);
    expect(createSessionWorkspaceProps(state).collapsed).toBe(false);
    expect(state.sidebarOpen).toBe(true);
    expect(state.sidebarContent).toBe(canvasContent);

    const collapseEvent = dispatchSidebarShortcut(pane);

    expect(collapseEvent.defaultPrevented).toBe(true);
    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
    expect(state.sidebarOpen).toBe(true);
    expect(state.sidebarContent).toBe(canvasContent);

    const mainSidebarEvent = dispatchSidebarShortcut(pane, false);
    expect(mainSidebarEvent.defaultPrevented).toBe(false);

    pane.active = false;
    const inactivePaneEvent = dispatchSidebarShortcut(pane);
    expect(inactivePaneEvent.defaultPrevented).toBe(false);
    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
  });
});

describe("chat pane session creation lifecycle", () => {
  it("drops a created session after a same-client reconnect", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.createSession();
    state.connected = false;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.connected = true;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    created.resolve("agent:main:new");

    await expect(pending).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not publish a stale creation error after the context is replaced", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });
    const replacementSessions = {} as SessionCapability;

    const pending = pane.createSession();
    state.sessionsError = "stale sessions.create failure";
    pane.context = createSessionContext(client, replacementSessions);
    created.resolve(null);

    await expect(pending).resolves.toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does not publish a stale creation error after the pane detaches", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });

    const pending = pane.createSession();
    state.sessionsError = "stale sessions.create failure";
    Object.defineProperty(pane, "isConnected", {
      configurable: true,
      value: false,
    });
    created.resolve(null);

    await expect(pending).resolves.toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});

describe("chat pane catalog session lifecycle", () => {
  it("shows the eligible catalog terminal action and dispatches its typed reference", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-101",
    } satisfies CatalogSessionKey;
    state.sessionKey = buildCatalogSessionKey(key);
    state.terminalAvailable = true;
    pane.catalogSession = {
      threadId: key.threadId,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
      canOpenTerminal: true,
    };
    const container = document.createElement("div");
    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state, { onOpenSession: () => {} }),
        undefined,
        true,
        undefined,
        false,
      ),
      container,
    );
    let detail: unknown;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener("openclaw:terminal-toggle", listener);
    try {
      (container.querySelector('[aria-label="Open in terminal"]') as HTMLElement).click();
    } finally {
      window.removeEventListener("openclaw:terminal-toggle", listener);
    }
    expect(detail).toEqual({ open: true, catalog: key });
  });

  it("finds continuation metadata on a later catalog page", async () => {
    const key = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-101",
    } satisfies CatalogSessionKey;
    const selectedSession: SessionCatalogSession = {
      threadId: key.threadId,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    const firstPage: SessionsCatalogListResult = {
      catalogs: [
        {
          id: key.catalogId,
          label: "Codex",
          capabilities: { continueSession: true, archive: true },
          hosts: [
            {
              hostId: key.hostId,
              label: "Gateway",
              kind: "gateway",
              connected: true,
              sessions: [],
              nextCursor: "page-2",
            },
          ],
        },
      ],
    };
    const secondPage: SessionsCatalogListResult = {
      catalogs: [
        {
          ...firstPage.catalogs[0]!,
          hosts: [{ ...firstPage.catalogs[0]!.hosts[0]!, sessions: [selectedSession] }],
        },
      ],
    };
    const transcript: SessionsCatalogReadResult = {
      hostId: key.hostId,
      threadId: key.threadId,
      items: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(transcript);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.sessionKey = buildCatalogSessionKey(key);

    await pane.loadCatalogSession(key, false);

    expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      catalogId: key.catalogId,
      hostIds: [key.hostId],
      limitPerHost: 100,
      cursors: { [key.hostId]: "page-2" },
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.read", {
      catalogId: key.catalogId,
      hostId: key.hostId,
      threadId: key.threadId,
      limit: 50,
    });
    expect(pane.catalogSession).toEqual(selectedSession);
  });

  it.each([
    {
      name: "uses a raw command for an empty tool call",
      item: { type: "toolCall", raw: { command: "git status --short" } },
      expected: "Tool call\n\ngit status --short",
    },
    {
      name: "uses aggregated output for an empty tool result",
      item: { type: "toolResult", raw: { aggregatedOutput: "working tree clean" } },
      expected: "Tool result\n\nworking tree clean",
    },
    {
      name: "renders an empty reasoning item as its label alone",
      item: { type: "reasoning" },
      expected: "Thinking",
    },
  ])("$name", ({ item, expected }) => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    const message = pane.catalogItemMessage(item as SessionCatalogTranscriptItem) as {
      content: Array<{ text: string }>;
    };

    expect(message.content[0]?.text).toBe(expected);
    expect(message.content[0]?.text).not.toContain("Unsupported external session item");
  });

  it("clamps oversized aggregated tool output before rendering", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    const message = pane.catalogItemMessage({
      type: "toolResult",
      raw: { aggregatedOutput: "x".repeat(5000) },
    } as SessionCatalogTranscriptItem) as { content: Array<{ text: string }> };

    // The 500-char preview cap keeps a single huge tool result from injecting
    // megabytes into one chat message; the "Tool result\n\n" prefix adds a bit.
    expect(message.content[0]?.text.length).toBeLessThan(600);
    expect(message.content[0]?.text.startsWith("Tool result")).toBe(true);
  });

  it("skips an empty unknown catalog item", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    expect(pane.catalogItemMessage({ type: "other" })).toBeNull();
  });

  it("preserves provider order when catalog items omit timestamps", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    expect(
      pane.catalogItemMessage({ id: "u1", type: "userMessage", text: "older question" }),
    ).not.toHaveProperty("timestamp");
  });

  it("exhausts pagination when an older read does not advance the cursor", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "u1", type: "userMessage", text: "hi" }],
      // Same cursor the request was made with: a stale provider that would loop.
      nextCursor: "cursor-1",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-1";

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(false);
    // Cursor cleared → hasOlderMessages() is false, so the observer will not refire.
    expect(pane.catalogCursor).toBeUndefined();
  });

  it("keeps paging when an advancing older page renders nothing new", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      // A page of only unsupported/empty items renders nothing but still advances
      // the cursor: older renderable history may sit behind it, so paging continues.
      items: [{ id: "x1", type: "other" }],
      nextCursor: "cursor-2",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-1";

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(true);
    expect(pane.catalogCursor).toBe("cursor-2");
  });

  it("exhausts pagination when an older read cycles back to a visited cursor", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "x1", type: "other" }],
      // Cursor points back to one already visited this session: a c1 -> c2 -> c1
      // cycle that would otherwise loop forever on empty pages.
      nextCursor: "cursor-1",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-2";
    pane.olderCursorsSeen.add("cursor-1");

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(false);
    expect(pane.catalogCursor).toBeUndefined();
  });

  it("re-arms a failed older-page load only after another user scroll", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.handleChatScroll = vi.fn();
    pane.historyAutoLoadBlocked = true;
    pane.transcriptScrollTop = 100;
    pane.syncHistoryObserver = vi.fn();
    const event = new Event("scroll");
    const thread = document.createElement("div");
    thread.scrollTop = 80;
    Object.defineProperty(event, "target", { value: thread });

    pane.handleTranscriptScroll(event);

    expect(pane.historyAutoLoadBlocked).toBe(false);
    expect(pane.syncHistoryObserver).toHaveBeenCalledOnce();
    expect(state.handleChatScroll).toHaveBeenCalledWith(event);
  });

  it("does not arm older history on downward or in-flight scroll movement", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.handleChatScroll = vi.fn();
    pane.transcriptScrollTop = 100;
    pane.syncHistoryObserver = vi.fn();
    const thread = document.createElement("div");
    const event = new Event("scroll");
    Object.defineProperty(event, "target", { value: thread });

    thread.scrollTop = 120;
    pane.handleTranscriptScroll(event);
    pane.loadingOlder = true;
    thread.scrollTop = 80;
    pane.handleTranscriptScroll(event);

    expect(pane.syncHistoryObserver).not.toHaveBeenCalled();
    expect(state.handleChatScroll).toHaveBeenCalledTimes(2);
  });

  it("loads a blocked unscrollable transcript from renewed upward intent", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.historyAutoLoadBlocked = true;
    pane.hasOlderMessages = vi.fn(() => true);
    pane.loadOlderMessages = vi.fn(async () => undefined);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("TouchEvent", undefined);
    const thread = document.createElement("div");
    const event = new WheelEvent("wheel", { deltaY: -1 });
    Object.defineProperty(event, "currentTarget", { value: thread });

    pane.handleTranscriptHistoryIntent(event);
    pane.handleTranscriptHistoryIntent(event);
    await Promise.resolve();

    expect(pane.loadOlderMessages).toHaveBeenCalledOnce();
    expect(pane.historyAutoLoadBlocked).toBe(false);
  });

  it("loads a blocked unscrollable transcript from a downward touch pull", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.historyAutoLoadBlocked = true;
    pane.hasOlderMessages = vi.fn(() => true);
    pane.loadOlderMessages = vi.fn(async () => undefined);
    vi.stubGlobal("IntersectionObserver", undefined);
    class TestTouchEvent extends Event {
      readonly touches: Array<{ clientY: number }>;

      constructor(type: string, clientY: number) {
        super(type);
        this.touches = [{ clientY }];
      }
    }
    vi.stubGlobal("TouchEvent", TestTouchEvent);
    const thread = document.createElement("div");
    const touchEvent = (type: string, clientY: number) => {
      const event = new TestTouchEvent(type, clientY);
      Object.defineProperty(event, "currentTarget", { value: thread });
      return event;
    };

    pane.handleTranscriptHistoryIntent(touchEvent("touchstart", 100));
    pane.handleTranscriptHistoryIntent(touchEvent("touchmove", 106));
    pane.handleTranscriptHistoryIntent(touchEvent("touchmove", 112));
    await Promise.resolve();

    expect(pane.loadOlderMessages).toHaveBeenCalledOnce();
    expect(pane.historyAutoLoadBlocked).toBe(false);
  });
});

describe("chat pane task suggestion lifecycle", () => {
  it("keeps accept ownership when the resolved event arrives before the response", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn((method: string) =>
        method === "taskSuggestions.accept"
          ? accepted.promise
          : Promise.resolve({ suggestions: [] } satisfies TaskSuggestionsListResult),
      ),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.acceptTaskSuggestion(suggestion);
    pane.handleTaskSuggestionEvent({
      action: "resolved",
      taskId: suggestion.id,
      resolution: "accepted",
    });
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });

    await pending;
    expect(navigate).toHaveBeenCalledWith("single", "agent:main:task");
  });

  it("drops an accept response after a same-client reconnect", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn(() => accepted.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.acceptTaskSuggestion(suggestion);
    pane.connectionGeneration += 1;
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:stale" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
  });

  it("drops a list response after a same-client reconnect", async () => {
    const listed = createDeferred<TaskSuggestionsListResult>();
    const client = {
      request: vi.fn(() => listed.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });

    const pending = pane.refreshTaskSuggestions();
    pane.connectionGeneration += 1;
    listed.resolve({ suggestions: [suggestion] });

    await pending;
    expect(pane.taskSuggestions).toEqual([]);
  });
});
