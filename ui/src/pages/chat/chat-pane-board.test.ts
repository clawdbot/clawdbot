/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import {
  acquireBoardProviderForSession,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import type { ObserverDigestHistory } from "../../lib/observer-digest.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./chat-pane.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  detachPanelToColumn,
  mergePanelIntoColumn,
  openSlot,
  type SidebarLayout,
} from "./sidebar-layout.ts";

type TestChatPane = HTMLElement & {
  boardChatDockSize: { height: number };
  boardProvider?: BoardProvider;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  state: ChatPageHost;
  createSession: () => Promise<boolean>;
  resetConfirmationOpen: boolean;
  routeFace: "chat" | "dashboard";
  onFaceChange?: (face: "chat" | "dashboard") => void;
  observerDigestHistory: ObserverDigestHistory;
  confirmConversationReset: () => Promise<boolean>;
  settleResetConfirmation: (confirmed: boolean) => void;
  updated: () => void;
  handleBoardCommand: (event: BoardCommandEvent) => void;
  handleBoardDockChange: (dock: "bottom" | "hidden" | "left" | "right") => void;
  handleBoardDockResize: (
    dock: "bottom" | "left" | "right",
    event: CustomEvent<{ splitRatio: number }>,
  ) => void;
  commitSidebarPanelMove: (
    layout: SidebarLayout,
    panelId: string,
    targetSide: "left" | "right",
    board: ResolvedBoardView,
  ) => void;
  syncChatSidebarForDock: (dock: "bottom" | "hidden" | "left" | "right") => boolean;
  persistBoardSessionView: (patch: { face?: "chat" | "dashboard"; activeTabId?: string }) => void;
  recordObserverDigest: (digest: SessionObserverDigest) => void;
  resolveBoardProvider: () => BoardProvider;
  resolveObserverDigestHistoryKey: (sessionKey?: string, agentId?: string) => string;
  refreshBuiltinBoardSnapshot: () => void;
  resolveBoardView: () => ResolvedBoardView;
};

type MockProvider = BoardProvider & { emitCommand(command: BoardCommandEvent["command"]): void };

function mockBoardProvider(sessionKey: string): MockProvider {
  return boardProviderForSession(sessionKey) as MockProvider;
}

function nullBoardProvider(sessionKey: string): BoardProvider {
  window.history.replaceState({}, "", "/");
  return boardProviderForSession(sessionKey);
}

function createTestPane(sessions: SessionCapability = {} as SessionCapability) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  const client = {} as GatewayBrowserClient;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  pane.context = {
    sessions,
    gateway: { snapshot: { client, phase: "connected" } },
  } as unknown as ApplicationContext;
  pane.state = {
    chatError: null,
    chatLoading: false,
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client,
    connected: true,
    lastError: null,
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
    requestUpdate: vi.fn(),
    sessionKey: "agent:main:current",
    sidebarFocusPanelId: "",
    sidebarFocusVersion: 0,
    sidebarLayout: { columns: [] },
    sessions,
    sessionsError: null,
    sessionsLoading: false,
  } as unknown as ChatPageHost;
  pane.state.updateSidebarLayout = (layout) => {
    pane.state.sidebarLayout = layout;
  };
  pane.state.updateSidebarActivePanel = (panelId) => {
    pane.state.sidebarFocusPanelId = panelId;
    pane.state.sidebarFocusVersion += 1;
  };
  pane.connectedClient = client;
  pane.connectionGeneration = 1;
  return pane;
}

function createGatewayBoardPane(params: {
  sessionKey: string;
  methods?: readonly string[];
  scopes?: readonly string[];
  capabilities?: readonly string[];
  lifecycleConnected?: boolean;
}) {
  window.history.replaceState({}, "", "/");
  const pane = createTestPane();
  const snapshot = { sessionKey: params.sessionKey, revision: 1, tabs: [], widgets: [] };
  const removeListener = vi.fn();
  const request = vi.fn(async () => snapshot);
  const addEventListener = vi.fn(() => removeListener);
  const client = { request, addEventListener } as unknown as GatewayBrowserClient;
  pane.state.sessionKey = params.sessionKey;
  pane.state.client = client;
  Reflect.set(pane, "boardProviderLifecycleConnected", params.lifecycleConnected ?? true);
  pane.context = {
    ...pane.context,
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: {
          ...(params.scopes ? { auth: { role: "operator", scopes: params.scopes } } : {}),
          features: {
            methods: params.methods ?? ["board.get"],
            ...(params.capabilities ? { capabilities: params.capabilities } : {}),
          },
        },
      },
    },
  } as unknown as ApplicationContext;
  return { pane, snapshot, client, request, addEventListener, removeListener };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  window.history.replaceState({}, "", "/?mockBoard=1");
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("chat pane board shell", () => {
  it("adds the observer-only board face without replacing the default chat face", async () => {
    const pane = createTestPane();
    pane.boardProvider = nullBoardProvider("agent:main:observer-only");
    pane.state.sessionKey = "agent:main:observer-only";
    pane.observerDigestHistory.record({
      sessionKey: "agent:main:observer-only",
      runId: "run-1",
      revision: 1,
      updatedAt: 1_000,
      headline: "Reviewing the board tests",
      health: "on-track",
    });

    pane.refreshBuiltinBoardSnapshot();

    await vi.waitFor(() =>
      expect(pane.resolveBoardView()).toMatchObject({
        activeTabId: "builtin-observer",
        face: "chat",
        hasBoard: true,
      }),
    );
    const onFaceChange = vi.fn((face: "chat" | "dashboard") => {
      pane.routeFace = face;
    });
    pane.onFaceChange = onFaceChange;
    pane.persistBoardSessionView({ face: "dashboard" });
    expect(onFaceChange).toHaveBeenCalledWith("dashboard");
    expect(pane.resolveBoardView().face).toBe("dashboard");
  });

  it("shares observer history between a global session and its explicit agent alias", async () => {
    const pane = createTestPane();
    pane.context = {
      ...pane.context,
      agents: {
        state: {
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: [{ id: "main" }, { id: "work" }],
          },
        },
      },
      agentSelection: { state: { selectedId: "work", scopeId: "work" } },
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          ...pane.context.gateway.snapshot,
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "main",
                mainKey: "main",
                mainSessionKey: "global",
                scope: "global",
              },
            },
          } as never,
        },
      },
    } as unknown as ApplicationContext;
    pane.state.sessionKey = "agent:work:main";
    pane.boardProvider = nullBoardProvider("agent:work:main");
    pane.observerDigestHistory.record({
      sessionKey: "agent:work:global",
      agentId: "work",
      runId: "run-work",
      revision: 1,
      updatedAt: 1_000,
      headline: "Reviewing the work agent",
      health: "on-track",
    });

    expect(pane.resolveObserverDigestHistoryKey("global", "work")).toBe("agent:work:global");
    expect(pane.resolveObserverDigestHistoryKey("agent:work:main")).toBe("agent:work:global");
    pane.recordObserverDigest({
      sessionKey: "global",
      runId: "run-ownerless",
      revision: 2,
      updatedAt: 2_000,
      headline: "Ownerless global status",
      health: "stuck",
    });
    expect(pane.observerDigestHistory.get("agent:work:global").at(-1)?.headline).toBe(
      "Reviewing the work agent",
    );
    pane.refreshBuiltinBoardSnapshot();

    await vi.waitFor(() => expect(pane.resolveBoardView().hasBoard).toBe(true));
  });

  it("gates New Chat when the current session has a board", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();

    expect(pane.resetConfirmationOpen).toBe(true);
    expect(sessions.create).not.toHaveBeenCalled();
    pane.settleResetConfirmation(false);
    await expect(pending).resolves.toBe(false);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("resets a board-bearing session in place so its dashboard stays", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    pane.state.client = client;
    pane.context = {
      ...pane.context,
      gateway: { snapshot: { client, phase: "connected" } },
    } as unknown as ApplicationContext;
    pane.connectedClient = client;
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(true);
    expect(reset).toHaveBeenCalledWith("agent:main:current", {});
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("rechecks reset scope after board confirmation", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(pane.state.lastError).toContain("operator.admin");
    expect(pane.state.chatError).toBe(pane.state.lastError);
  });

  it("does not reset when a run starts during confirmation", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.state.chatRunId = "run-started-during-confirmation";
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("cancels New Chat when the selected session changes during confirmation", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset: vi.fn(async () => "completed" as const),
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.state.sessionKey = "agent:main:other";
    pane.updated();

    await expect(pending).resolves.toBe(false);
    expect(pane.resetConfirmationOpen).toBe(false);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.reset).not.toHaveBeenCalled();
  });

  it("does not share reset confirmation across sessions", async () => {
    const pane = createTestPane();
    pane.boardProvider = mockBoardProvider("agent:main:first");
    pane.state.sessionKey = "agent:main:first";

    const first = pane.confirmConversationReset();
    pane.state.sessionKey = "agent:main:second";
    pane.boardProvider = mockBoardProvider("agent:main:second");
    const second = pane.confirmConversationReset();

    await expect(first).resolves.toBe(false);
    expect(pane.resetConfirmationOpen).toBe(true);
    pane.settleResetConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  it("keeps chat-only reset confirmation disabled", async () => {
    const pane = createTestPane();
    pane.boardProvider = nullBoardProvider("agent:main:current");

    await expect(pane.confirmConversationReset()).resolves.toBe(true);
    expect(pane.resetConfirmationOpen).toBe(false);
  });

  it("reacts to transient set_chat_dock provider events", () => {
    const pane = createTestPane();
    const provider = mockBoardProvider("agent:main:current");
    pane.boardProvider = provider;
    const unsubscribe = provider.events.subscribe((event) => pane.handleBoardCommand(event));

    provider.emitCommand({ kind: "set_chat_dock", dock: "left" });

    expect(pane.resolveBoardView()).toMatchObject({ activeTabId: "main", dock: "left" });
    unsubscribe();
  });

  it("restores the visible dock edge after hidden state reloads", () => {
    const provider = mockBoardProvider("agent:main:current");
    const pane = createTestPane();
    pane.boardProvider = provider;

    pane.handleBoardDockChange("left");
    pane.handleBoardDockChange("hidden");

    expect(
      pane.state.sidebarLayout.columns.flatMap((column) =>
        column.panels.map((panel) => panel.slot),
      ),
    ).toContain("chat");

    const reloadedPane = createTestPane();
    reloadedPane.boardProvider = provider;
    expect(reloadedPane.resolveBoardView()).toMatchObject({
      dock: "hidden",
      reopenDock: "left",
    });
  });

  it("updates the board dock when chat is dragged across sides", () => {
    const pane = createTestPane();
    const provider = mockBoardProvider("agent:main:current");
    pane.boardProvider = provider;
    const renderedLayout = openSlot({ columns: [] }, "chat", "left");
    pane.state.sidebarLayout = { columns: [] };
    const chatPanel = renderedLayout.columns[0]!.panels[0]!;
    const moved = detachPanelToColumn(renderedLayout, chatPanel.id, "right", 0);
    const board = { ...pane.resolveBoardView(), dock: "left" as const };

    pane.commitSidebarPanelMove(moved, chatPanel.id, "right", board);

    expect(pane.state.sidebarLayout.columns[0]?.side).toBe("right");
    expect(pane.resolveBoardView().dock).toBe("right");
  });

  it("persists the moved panel as the collapsed active panel", () => {
    const pane = createTestPane();
    const renderedLayout = openSlot(openSlot({ columns: [] }, "detail"), "discussion");
    pane.state.sidebarLayout = renderedLayout;
    const discussionPanel = renderedLayout.columns[1]!.panels[0]!;
    const moved = mergePanelIntoColumn(
      renderedLayout,
      discussionPanel.id,
      renderedLayout.columns[0]!.id,
      0,
    );

    pane.commitSidebarPanelMove(moved, discussionPanel.id, "right", pane.resolveBoardView());

    // The collapsed layout reads this separate selection, so a drag must update it
    // or the narrow view foregrounds a stale panel after resizing.
    expect(pane.state.sidebarFocusPanelId).toBe(discussionPanel.id);
  });

  it("activates an existing tabbed chat panel when reopening a side dock", () => {
    const pane = createTestPane();
    const withChat = openSlot(openSlot({ columns: [] }, "chat"), "discussion");
    const chatPanel = withChat.columns[0]!.panels[0]!;
    const discussionPanel = withChat.columns[1]!.panels[0]!;
    pane.state.sidebarLayout = mergePanelIntoColumn(
      withChat,
      discussionPanel.id,
      withChat.columns[0]!.id,
      1,
    );
    pane.state.sidebarLayout.columns[0]!.activePanelId = discussionPanel.id;

    expect(pane.syncChatSidebarForDock("right")).toBe(true);

    expect(pane.state.sidebarLayout.columns[0]?.activePanelId).toBe(chatPanel.id);
    expect(pane.state.sidebarFocusPanelId).toBe(chatPanel.id);
  });

  it("restores one board view across equivalent main session keys", () => {
    const pane = createTestPane();
    pane.context = {
      ...pane.context,
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          ...pane.context.gateway.snapshot,
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "main",
                mainKey: "main",
                mainSessionKey: "agent:main:main",
              },
            },
          } as never,
        },
      },
    };
    pane.state.sessionKey = "agent:main:main";
    pane.boardProvider = mockBoardProvider("main");
    pane.routeFace = "dashboard";
    pane.persistBoardSessionView({ activeTabId: "research" });

    pane.boardProvider = mockBoardProvider("agent:main:main");

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });
  });

  it("uses in-memory tab preferences while the route owns the face", () => {
    const pane = createTestPane();
    pane.routeFace = "dashboard";
    pane.boardProvider = mockBoardProvider("agent:main:current");
    pane.state.settings = {
      ...loadSettings(),
      boardSessionViews: {
        "agent:main:current": { activeTabId: "research" },
      },
    };
    localStorage.clear();

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });

    pane.persistBoardSessionView({ activeTabId: "main" });
    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "main",
      face: "dashboard",
    });
  });

  it("preserves preferences saved by another split pane", () => {
    const initialSettings = patchSettings({
      boardSessionViews: {
        "agent:main:first": { activeTabId: "main" },
      },
    });
    const firstPane = createTestPane();
    firstPane.routeFace = "dashboard";
    firstPane.state.sessionKey = "agent:main:first";
    firstPane.state.settings = initialSettings;
    firstPane.boardProvider = mockBoardProvider("agent:main:first");
    const secondPane = createTestPane();
    secondPane.routeFace = "dashboard";
    secondPane.state.sessionKey = "agent:main:second";
    secondPane.state.settings = initialSettings;
    secondPane.boardProvider = mockBoardProvider("agent:main:second");

    firstPane.persistBoardSessionView({ activeTabId: "research" });

    secondPane.state.sessionKey = "agent:main:first";
    secondPane.boardProvider = mockBoardProvider("agent:main:first");
    expect(secondPane.resolveBoardView()).toMatchObject({
      face: "dashboard",
      activeTabId: "research",
    });

    secondPane.state.sessionKey = "agent:main:second";
    secondPane.boardProvider = mockBoardProvider("agent:main:second");
    secondPane.persistBoardSessionView({ activeTabId: "main" });

    expect(loadSettings().boardSessionViews).toMatchObject({
      "agent:main:first": { activeTabId: "research" },
      "agent:main:second": { activeTabId: "main" },
    });
  });

  it("resolves configured main aliases before selecting a provider", () => {
    const pane = createTestPane();
    pane.state.sessionKey = "primary";
    pane.context = {
      ...pane.context,
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          ...pane.context.gateway.snapshot,
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "work",
                mainKey: "primary",
                mainSessionKey: "agent:work:primary",
              },
            },
          } as never,
        },
      },
    };

    expect(pane.resolveBoardProvider().snapshot$.value.sessionKey).toBe("agent:work:primary");
  });

  it("does not subscribe to a gateway board before the pane owns a lifecycle lease", async () => {
    const sessionKey = "agent:main:board-lifecycle-ownership";
    const { pane, snapshot, request, addEventListener, removeListener } = createGatewayBoardPane({
      sessionKey,
      scopes: ["operator.read", "operator.write"],
      lifecycleConnected: false,
    });

    expect(pane.resolveBoardProvider().snapshot$.value.sessionKey).toBe(sessionKey);
    expect(request).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();

    Reflect.set(pane, "boardProviderLifecycleConnected", true);
    const provider = pane.resolveBoardProvider();
    try {
      await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(snapshot));
      expect(request).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledOnce();
    } finally {
      const release = Reflect.get(pane, "releaseBoardProviderLease") as () => void;
      release.call(pane);
    }

    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("keeps gateways without board support on the null provider", () => {
    const { pane, request, addEventListener } = createGatewayBoardPane({
      sessionKey: "agent:main:board-unsupported",
      methods: ["chat.history"],
    });

    expect(pane.resolveBoardProvider()).toMatchObject({
      canMutate: false,
      canGrant: false,
      canPinWidgets: false,
      canPinMcpApps: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("does not reuse another board lease after gateway board support disappears", () => {
    const sessionKey = "agent:main:board-support-revoked";
    const { pane, client, addEventListener } = createGatewayBoardPane({
      sessionKey,
      methods: ["chat.history"],
    });

    const otherConsumer = acquireBoardProviderForSession(sessionKey, client);
    try {
      expect(pane.resolveBoardProvider()).toMatchObject({
        canMutate: false,
        canGrant: false,
        canPinWidgets: false,
        canPinMcpApps: false,
      });
      expect(addEventListener).toHaveBeenCalledOnce();
    } finally {
      otherConsumer.release();
    }
  });

  it("enables MCP App pinning only when app-view and put methods are both advertised", () => {
    const cases = [
      { suffix: "put-only", methods: ["board.get", "board.widget.put"], expected: false },
      { suffix: "view-only", methods: ["board.get", "board.widget.appView"], expected: false },
      {
        suffix: "complete",
        methods: ["board.get", "board.widget.appView", "board.widget.put"],
        expected: true,
      },
    ];

    for (const testCase of cases) {
      const { pane } = createGatewayBoardPane({
        sessionKey: `agent:main:${testCase.suffix}`,
        methods: testCase.methods,
      });
      expect(pane.resolveBoardProvider().canPinMcpApps).toBe(testCase.expected);
    }
  });

  it("updates chat authorization without changing another consumer of the same board", async () => {
    const sessionKey = "agent:main:chat-lease-scope-change";
    const features = {
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    };
    const { pane, snapshot, client, request, addEventListener, removeListener } =
      createGatewayBoardPane({
        sessionKey,
        scopes: ["operator.read", "operator.write"],
        methods: features.methods,
        capabilities: features.capabilities,
      });
    const chat = pane.resolveBoardProvider();
    const approvals = acquireBoardProviderForSession(
      sessionKey,
      client,
      true,
      false,
      false,
      false,
      true,
    );

    try {
      await vi.waitFor(() => expect(chat.snapshot$.value).toEqual(snapshot));
      expect(chat).toMatchObject({
        canPinWidgets: true,
        canPinMcpApps: true,
        canMutate: true,
        canGrant: false,
      });
      expect(approvals.provider).toMatchObject({
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: false,
        canGrant: true,
      });

      pane.context = {
        ...pane.context,
        gateway: {
          snapshot: {
            client,
            phase: "connected",
            hello: {
              auth: { role: "operator", scopes: ["operator.read"] },
              features,
            },
          },
        },
      } as unknown as ApplicationContext;

      expect(pane.resolveBoardProvider()).toBe(chat);
      expect(chat).toMatchObject({
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: false,
        canGrant: false,
      });
      expect(approvals.provider.canGrant).toBe(true);
      expect(approvals.provider.canMutate).toBe(false);
      expect(request).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledOnce();

      approvals.release();
      expect(removeListener).not.toHaveBeenCalled();
      const release = Reflect.get(pane, "releaseBoardProviderLease") as () => void;
      release.call(pane);
      expect(removeListener).toHaveBeenCalledOnce();
    } finally {
      approvals.release();
      const release = Reflect.get(pane, "releaseBoardProviderLease") as () => void;
      release.call(pane);
    }
  });

  it.each([
    {
      profile: "read-only",
      scopes: ["operator.read"],
      canMutate: false,
      canGrant: false,
    },
    {
      profile: "writer with approvals",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      canMutate: true,
      canGrant: true,
    },
  ])("derives board actions from the $profile connection scopes", (profile) => {
    const { pane } = createGatewayBoardPane({
      sessionKey: `agent:main:scope-${profile.profile.replaceAll(" ", "-")}`,
      scopes: profile.scopes,
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    });
    const provider = pane.resolveBoardProvider();
    expect(provider.canMutate).toBe(profile.canMutate);
    expect(provider.canGrant).toBe(profile.canGrant);
    expect(provider.canPinWidgets).toBe(profile.canMutate);
    expect(provider.canPinMcpApps).toBe(profile.canMutate);
  });

  it("persists bottom chat dock resizing across pane recreation", () => {
    const pane = createTestPane();
    const previous = document.createElement("div");
    const divider = document.createElement("div");
    const next = document.createElement("div");
    previous.getBoundingClientRect = () => ({ height: 650 }) as DOMRect;
    next.getBoundingClientRect = () => ({ height: 350 }) as DOMRect;
    const container = document.createElement("div");
    container.append(previous, divider, next);
    divider.addEventListener("resize", (event) => {
      pane.handleBoardDockResize("bottom", event as unknown as CustomEvent<{ splitRatio: number }>);
    });
    divider.dispatchEvent(new CustomEvent("resize", { detail: { splitRatio: 0.65 } }));

    const recreated = createTestPane();
    expect(recreated.boardChatDockSize.height).toBe(350);
  });
});
