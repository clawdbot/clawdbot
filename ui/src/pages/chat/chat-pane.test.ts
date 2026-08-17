/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { showToast } from "../../lib/toast.ts";
import {
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import {
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";
import { cacheChatSessionSnapshot, type ChatMessageCache } from "./session-message-cache.ts";
import { openSlot } from "./sidebar-layout.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

function dispatchSidebarShortcut(pane: TestChatPane, shiftKey = true) {
  const event = new KeyboardEvent("keydown", {
    cancelable: true,
    key: "и",
    code: "KeyB",
    metaKey: true,
    shiftKey,
  });
  pane.handleDocumentKeydown(event);
  return event;
}

function createInitializationContext(): ApplicationContext {
  return {
    basePath: "",
    gateway: {
      snapshot: {
        client: null,
        phase: "stopped",
        offlineStable: false,
        hello: null,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        sessionKey: "",
        lastError: null,
        lastErrorCode: null,
      },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    },
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
    chatAttachmentHandoff: createChatAttachmentHandoff(),
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

describe("chat pane header state", () => {
  it("forks through the shared session organizer flow and selects the new session", async () => {
    const create = vi.fn(async () => "agent:main:forked");
    const sessions = {
      create,
      state: { error: null },
    } as unknown as SessionCapability;
    const { pane } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
    Object.assign(pane.context.gateway.snapshot.hello?.features ?? {}, {
      methods: ["sessions.patch", "sessions.create"],
    });
    const onPaneSessionChange = vi.fn();
    pane.onPaneSessionChange = onPaneSessionChange;
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      hasActiveRun: true,
    } satisfies GatewaySessionRow;

    await pane.handleHeaderSessionAction({ kind: "fork" }, session);

    expect(create).toHaveBeenCalledWith({
      parentSessionKey: session.key,
      fork: true,
      forkFrom: "last-completed",
      agentId: "main",
    });
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it("aborts a stale header delete confirm and shows a retry notice when the connection is replaced while it is open", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const deleteOne = vi.fn(async () => ({ deleted: true }));
      const sessions = {
        delete: deleteOne,
        refreshReplacement: vi.fn(async () => undefined),
      } as unknown as SessionCapability;
      const client = {} as GatewayBrowserClient;
      const { pane } = createTestChatPane({ client, sessions });
      const session = {
        key: "agent:main:current",
        kind: "direct",
        updatedAt: 0,
        label: "Current session",
      } satisfies GatewaySessionRow;

      const pending = pane.handleHeaderSessionAction({ kind: "delete" }, session);
      await waitForConfirmDialogActions();
      // Mirrors a reconnect landing while the header's own confirm dialog is
      // open: the chat header builds this scope independently of
      // SessionDataController, so it needs its own signal retired here too.
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        phase: "reconnecting",
        hello: null,
      });
      await pending;

      expect(deleteOne).not.toHaveBeenCalled();
      // The stale dialog must dismiss itself, not merely stop sending its request.
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      // The abort resolves the dialog to `false`, same as a user cancel, so the
      // operator needs a distinct, visible outcome or their lost intent reads
      // as a click that simply did nothing.
      expect(showToast).toHaveBeenCalledWith({
        message: t("sessionsView.deleteSessionStale", { session: "Current session" }),
      });
    } finally {
      document.body.replaceChildren();
      restoreDialogPolyfill();
    }
  });

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

  it("renames the selected agent's canonical global session", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
    state.sessionKey = "global";
    state.assistantAgentId = "research";
    const session = {
      key: "global",
      kind: "global",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerRenameValue = "Research thread";
    pane.commitHeaderRename();

    expect(patch).toHaveBeenCalledWith(
      "global",
      { label: "Research thread" },
      { agentId: "research" },
    );
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

  it.each(["copy-path", "copy-branch"] as const)(
    "surfaces a rejected workspace %s clipboard action",
    async (action) => {
      const { pane, requestUpdate, state } = createTestChatPane({
        client: {} as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      const session = {
        key: "agent:main:current",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;
      const copy = vi.fn(async () => false);

      pane.handleHeaderMenuAction(action, session, "/src/openclaw", "feature/header", copy);

      await vi.waitFor(() => expect(state.chatError).toBe("Copy failed"));
      expect(state.lastError).toBe(state.chatError);
      expect(requestUpdate).toHaveBeenCalledOnce();
    },
  );

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
    expect(state.lastError).toBe(state.chatError);
  });

  it.each([
    {
      name: "leaving and returning before settlement",
      retire: (pane: TestChatPane) => {
        pane.presented = false;
        pane.presented = true;
      },
    },
    {
      name: "replacing the Gateway generation",
      retire: (pane: TestChatPane) => {
        pane.connectionGeneration += 1;
      },
    },
  ])("does not resurrect a reveal failure after $name", async ({ retire }) => {
    const revealed = createDeferred<{ ok: false; error: string }>();
    const request = vi.fn(() => revealed.promise);
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
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    retire(pane);
    revealed.resolve({ ok: false, error: "No desktop available." });
    await vi.waitFor(() => expect(request).toHaveResolved());

    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
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
    state.settings = {
      sessionKey: canonicalSessionKey,
      lastActiveSessionKey: canonicalSessionKey,
    } as ChatPageHost["settings"];
    state.hello = hello;
    state.loadAssistantIdentity = vi.fn(async () => {});
    pane.connectedClient = null;
    pane.onPaneSessionChange = navigate;
    pane.active = true;
    pane.presented = true;

    pane.applyGatewaySnapshot(snapshot);

    expect(navigate).toHaveBeenCalledWith("single", canonicalSessionKey, { replace: true });
    expect(pane.connectedClient).toBe(client);
    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      expect.objectContaining({ sessionKey: canonicalSessionKey }),
    );
  });

  it("keeps active turn state when re-entry canonicalizes the main route alias", () => {
    const canonicalSessionKey = "agent:main:main";
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: canonicalSessionKey,
        },
      },
    } as unknown as NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]>;
    pane.context = {
      ...pane.context,
      gateway: {
        ...pane.context.gateway,
        snapshot: { ...pane.context.gateway.snapshot, hello },
      },
    } as unknown as ApplicationContext;
    state.sessionKey = "main";
    state.hello = hello;
    state.initialUserMessage = createInitialUserMessageHandoff();
    state.chatRunId = "run-reconnected";
    state.chatStream = "The response survived navigation.";
    pane.sessionKey = canonicalSessionKey;

    (
      pane as TestChatPane & {
        willUpdate: (changedProperties: Map<PropertyKey, unknown>) => void;
      }
    ).willUpdate(new Map([["sessionKey", "main"]]));

    expect(state.sessionKey).toBe(canonicalSessionKey);
    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe("The response survived navigation.");
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
    state.sidebarLayout = openSlot({ columns: [] }, "detail");

    const hasWorkspace = () =>
      state.sidebarLayout.columns[0]?.panels.some((panel) => panel.slot === "workspace") === true;
    expect(hasWorkspace()).toBe(false);

    const expandEvent = dispatchSidebarShortcut(pane);

    expect(expandEvent.defaultPrevented).toBe(true);
    expect(hasWorkspace()).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "detail",
      "workspace",
    ]);
    expect(state.sidebarContent).toBe(canvasContent);

    const collapseEvent = dispatchSidebarShortcut(pane);

    expect(collapseEvent.defaultPrevented).toBe(true);
    expect(hasWorkspace()).toBe(false);
    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("detail");
    expect(state.sidebarContent).toBe(canvasContent);

    const mainSidebarEvent = dispatchSidebarShortcut(pane, false);
    expect(mainSidebarEvent.defaultPrevented).toBe(false);

    pane.active = false;
    const inactivePaneEvent = dispatchSidebarShortcut(pane);
    expect(inactivePaneEvent.defaultPrevented).toBe(false);
    expect(hasWorkspace()).toBe(false);
  });

  it("toggles the terminal tab in the active pane", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    state.terminalAvailable = true;
    const press = () => {
      const event = new KeyboardEvent("keydown", {
        cancelable: true,
        code: "Backquote",
        ctrlKey: true,
      });
      pane.handleDocumentKeydown(event);
      return event;
    };

    expect(press().defaultPrevented).toBe(true);
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);
    expect(press().defaultPrevented).toBe(true);
    expect(state.sidebarLayout.columns).toEqual([]);
    expect(state.sidebarLayout.open).toBe(true);
  });
});

describe("chat pane session creation lifecycle", () => {
  function advertiseSessionCreate(pane: TestChatPane) {
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.create"] },
    } as typeof pane.context.gateway.snapshot.hello;
  }

  it("drops a created session after a same-client reconnect", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionCreate(pane);

    const pending = pane.createSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
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
    advertiseSessionCreate(pane);

    const pending = pane.createSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
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
    advertiseSessionCreate(pane);

    const pending = pane.createSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
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

describe("chat pane history pagination intent", () => {
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
